// reply-prism 独自: 返事やツール行に出るファイルパスを、エディタで開くリンクにする。
// 純粋な関数だけを置く（`$` は register.tsx からしか触らない）。

export const EDITORS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'idea', 'file', 'off'] as const
export type Editor = (typeof EDITORS)[number]

/** 行番号の書き方: `:12`、`:12:5`、`:12-20`、`#L12`、`#L12-L20`。 */
const LINE_SUFFIX = String.raw`(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)`
const SEGMENT = String.raw`[\w.@+-]+`
/** `/` `~/` `./` `../` で始まるパス（本家と同じ形）。 */
const ROOTED = String.raw`(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)*`
/** `src/app/Foo.java` のような相対パス。最後の要素に英字の拡張子があるものだけ（`and/or` や `2026/10/05` を拾わない）。 */
const RELATIVE = String.raw`[\w@+-][\w.@+-]*(?:\/${SEGMENT})+`

/** 文中のパス。`decorate` が使う。行番号がついていれば含めて拾う。 */
export const PATH_IN_TEXT = new RegExp(String.raw`(?<![\w/.:~-])(${ROOTED}|${RELATIVE})(${LINE_SUFFIX})?`, 'g')
const WHOLE_PATH = new RegExp(String.raw`^(?:${ROOTED}|${RELATIVE})${LINE_SUFFIX}?$`)
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9_-]*$/

/** 拾ったパスの末尾についた文の句読点（`.` `,`）を外した長さ。 */
export const trimPathEnd = (text: string): number => text.replace(/[.,]+$/, '').length

/** 拡張子が無くてもファイルとみなす名前。 */
const KNOWN_NAMES = new Set(['Makefile', 'Dockerfile', 'Jenkinsfile', 'Gemfile', 'Rakefile', 'Procfile', 'Vagrantfile', 'LICENSE', 'README', 'CHANGELOG', 'hosts', 'crontab'])

/**
 * ファイルらしいか。最後の要素に拡張子（`.zshrc` のようなドットファイルも含む）があるか、
 * Makefile などの決まった名前か。ディレクトリや `/api/v1/users` のような URL のパスはリンクにしない。
 */
const isFileName = (path: string): boolean => {
  const last = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return HAS_EXTENSION.test(last) || KNOWN_NAMES.has(last)
}

export type PathTarget = { path: string; line?: number; col?: number }

/** `src/a.ts:12:5` → `{ path: 'src/a.ts', line: 12, col: 5 }`。範囲（`:12-20`）は始まりの行を使う。 */
export const splitTarget = (text: string): PathTarget => {
  const m = /^(.*?)(?::(\d+)(?::(\d+)|-\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(text)
  const path = m?.[1] ?? text
  const line = m?.[2] ?? m?.[4]
  const col = m?.[3]
  return { path, ...(line ? { line: Number(line) } : {}), ...(col ? { col: Number(col) } : {}) }
}

/** 文中から拾ったパス候補のうち、リンクにしてよいもの。 */
export const isLinkablePath = (text: string): boolean => isFileName(splitTarget(text).path)

/** 色つけ（本家の path 色）に回してよいか。`/` などで始まるものは本家どおり何でも、相対パスはファイルらしいものだけ。 */
export const isColorablePath = (text: string): boolean => /^(?:~|\.{1,2})?\//.test(text) || isLinkablePath(text)

/** インラインコード全体がパス（行番号つきも可）か。`` `src/a.ts:12` `` をリンクにするため。 */
export const isPathLike = (text: string): boolean => {
  const t = text.trim()
  if (t !== text || t === '' || /\s/.test(t)) return false
  if (/^[A-Za-z]:\\[^\s]+$/.test(t)) return true
  return WHOLE_PATH.test(t) && isLinkablePath(t)
}

const normalize = (abs: string): string => {
  const drive = /^[A-Za-z]:/.exec(abs)?.[0] ?? ''
  const rest = abs.slice(drive.length).replace(/\\/g, '/')
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${drive}/${out.join('/')}`
}

/** パスを絶対パスにする。相対パスは作業ディレクトリ基準。分からないときは undefined。 */
export const resolvePath = (path: string, cwd: string, home: string): string | undefined => {
  if (/^[A-Za-z]:[\\/]/.test(path)) return normalize(path)
  if (path === '~' || path.startsWith('~/')) return home ? normalize(home + path.slice(1)) : undefined
  if (path.startsWith('/')) return normalize(path)
  return cwd ? normalize(`${cwd}/${path}`) : undefined
}

/** URL のパス部分。要素ごとにエスケープし、Windows のドライブ（`C:`）はそのまま残す。 */
const encodePath = (abs: string): string => {
  const drive = /^[A-Za-z]:/.exec(abs)?.[0]
  const rest = drive ? abs.slice(drive.length) : abs
  const encoded = rest.split('/').map(encodeURIComponent).join('/')
  return drive ? `/${drive}${encoded}` : encoded
}

/** エディタで開く URL。`off`、または作れないときは undefined。 */
export const editorUrl = (editor: Editor, template: string, abs: string, line?: number, col?: number): string | undefined => {
  const path = encodePath(abs)
  if (template) {
    return template
      .replaceAll('{path}', path)
      .replaceAll('{line}', String(line ?? 1))
      .replaceAll('{col}', String(col ?? 1))
  }
  const suffix = line ? `:${line}${col ? `:${col}` : ''}` : ''
  switch (editor) {
    case 'vscode':
    case 'vscode-insiders':
    case 'cursor':
    case 'windsurf':
    case 'zed':
      return `${editor}://file${path}${suffix}`
    case 'idea':
      return `idea://open?file=${encodeURIComponent(abs)}${line ? `&line=${line}` : ''}${col ? `&column=${col}` : ''}`
    case 'file':
      return `file://${path}`
    case 'off':
      return undefined
  }
}

/** 表示中のパス文字列 → URL。`isFile` はツールの `file_path` のように、ファイルだと分かっているとき。 */
export type Linker = (text: string, isFile?: boolean) => string | undefined

/** 開く対象。絶対パスと行・桁。 */
export type OpenTarget = { abs: string; line?: number; col?: number }

/** 表示中のパス文字列 → 開く対象。リンクにしない（できない）ものは undefined。 */
export type Resolver = (text: string, isFile?: boolean) => OpenTarget | undefined

/** 表示されたパス文字列（`src/a.ts:12` など）→ 開く対象。`off` でひな形も無ければ null。 */
export const makeResolver = (editor: Editor, template: string, where: { cwd: string; home: string }): Resolver | null => {
  if (editor === 'off' && !template) return null
  return (text, isFile = false) => {
    if (!isFile && !isLinkablePath(text)) return undefined
    const target = splitTarget(text)
    const abs = resolvePath(target.path, where.cwd, where.home)
    if (abs === undefined || editorUrl(editor, template, abs, target.line, target.col) === undefined) return undefined
    return { abs, ...(target.line ? { line: target.line } : {}), ...(target.col ? { col: target.col } : {}) }
  }
}

/** 表示されたパス文字列（`src/a.ts:12` など）→ URL。 */
export const makeLinker = (editor: Editor, template: string, where: { cwd: string; home: string }): Linker | null => {
  const resolve = makeResolver(editor, template, where)
  if (!resolve) return null
  return (text, isFile = false) => {
    const t = resolve(text, isFile)
    return t && editorUrl(editor, template, t.abs, t.line, t.col)
  }
}

// ---- 押して開くボタン（全画面表示の端末ではリンクのクリックが Mod に届かないため） ----

/** エディタで開くボタンの key の頭。後ろは `行:桁:絶対パス`（無い行・桁は 0）。 */
export const OPEN_PREFIX = 'open:'

/** 開く対象 → ボタンの key。状態を持たずに key だけから対象を戻せる形。 */
export const openKey = (t: OpenTarget): string => `${OPEN_PREFIX}${t.line ?? 0}:${t.col ?? 0}:${t.abs}`

/** ボタンの key → 開く対象。開くボタンの key でなければ undefined。 */
export const parseOpenKey = (key: string): OpenTarget | undefined => {
  const m = /^open:(\d+):(\d+):(.+)$/s.exec(key)
  if (!m) return undefined
  const line = Number(m[1])
  const col = Number(m[2])
  return { abs: m[3]!, ...(line ? { line } : {}), ...(col ? { col } : {}) }
}

/** 返事の最後の「開く」の行に出す名前: ファイル名、行番号があれば `name:12`。 */
export const openLabel = (t: OpenTarget): string => `${t.abs.split('/').pop() || t.abs}${t.line ? `:${t.line}` : ''}`
