/**
 * 記録からツリーの行を組み立て、ペインの幅に収める（純関数）。
 */
import type { TouchTreeRecord, TouchTreeTouch } from '../types'
import { kindOf } from './record'
import type { Kind } from './record'

/** ツリーのファイル 1 件。 */
export type Leaf = { name: string; path: string; touch: TouchTreeTouch }

/** ツリーのディレクトリ 1 つ。count は配下（孫以下も）の件数、edits はそのうち書いたもの。 */
export type Dir = {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: Leaf[]
  count: number
  edits: number
}

/** リポジトリの枝と、リポジトリ外の枝。 */
export type Forest = {
  repo: Dir | null
  external: Dir | null
  /** showHits が false のとき隠した、検索に出ただけのファイルの数。 */
  hidden: number
}

/** 表示する 1 行。 */
export type Row = {
  kind: 'group' | 'dir' | 'file'
  /** 罫線（`│ ├ └`）。group は空。 */
  guide: string
  name: string
  /** 右端の補足（件数・行範囲・編集回数など）。 */
  meta: string
  /** ファイルの状態（file だけ）。 */
  state?: Kind
  /** 最後に触ったファイルか。 */
  isLast?: boolean
  path: string
}

/** 外部の枝の見出し。 */
export const EXTERNAL_LABEL = '(外部)'

const newDir = (name: string, path: string): Dir => ({ name, path, dirs: new Map(), files: [], count: 0, edits: 0 })

const isWritten = (touch: TouchTreeTouch): boolean => touch.created || touch.edits > 0

/** パスの名前部分。 */
export const baseName = (path: string): string => path.split('/').filter(s => s !== '').pop() ?? path

/** dir の下に segments をたどって 1 件入れる。途中のディレクトリの件数も数える。 */
function insert(top: Dir, segments: readonly string[], leaf: Leaf): void {
  let at = top
  const written = isWritten(leaf.touch)

  at.count += 1
  if (written) at.edits += 1

  for (const segment of segments.slice(0, -1)) {
    let child = at.dirs.get(segment)

    if (child === undefined) {
      child = newDir(segment, at.path === '' ? segment : `${at.path}/${segment}`)
      at.dirs.set(segment, child)
    }

    at = child
    at.count += 1
    if (written) at.edits += 1
  }

  at.files.push(leaf)
}

/**
 * 記録をリポジトリの枝と外部の枝に分けて木にする。
 *
 * - root の配下は root からの相対パスで並べる
 * - それ以外はホーム配下なら `~` から、ほかは `/` から並べる
 */
export function forestOf(record: TouchTreeRecord, showHits: boolean): Forest {
  const root = record.root.replace(/\/+$/, '')
  const repo = newDir(root === '' ? '' : baseName(root) || '/', '')
  const external = newDir(EXTERNAL_LABEL, '')
  let hidden = 0

  for (const [path, touch] of Object.entries(record.files)) {
    if (!showHits && kindOf(touch) === 'hit') {
      hidden += 1
      continue
    }

    const leaf: Leaf = { name: baseName(path), path, touch }

    if (root !== '' && path.startsWith(root + '/')) {
      insert(repo, path.slice(root.length + 1).split('/'), leaf)
    } else if (root === '/' && path.startsWith('/')) {
      insert(repo, path.slice(1).split('/'), leaf)
    } else if (record.home !== '' && path.startsWith(record.home + '/')) {
      insert(external, ['~', ...path.slice(record.home.length + 1).split('/')], leaf)
    } else {
      const parts = path.split('/').filter(s => s !== '')
      const [first, ...rest] = parts
      insert(external, first === undefined ? [path] : [`/${first}`, ...rest], leaf)
    }
  }

  return {
    repo: repo.count > 0 ? repo : null,
    external: external.count > 0 ? external : null,
    hidden,
  }
}

/** 行範囲の要約。3 つ以上なら先頭 2 つと残りの数。総行数が分かれば `/総行数` を付ける。 */
export function rangesText(touch: TouchTreeTouch): string {
  if (touch.ranges.length === 0) {
    return '一部'
  }

  const shown = touch.ranges.slice(0, 2).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
  const more = touch.ranges.length > 2 ? ` +${touch.ranges.length - 2}` : ''
  const total = touch.lines === undefined ? '' : `/${touch.lines}`

  return `${shown.join(',')}${more}${total}`
}

/** 読んだことの要約（全体なら行数）。読んでいなければ空。 */
function readText(touch: TouchTreeTouch): string {
  if (touch.whole) return touch.lines === undefined ? '全体' : `全${touch.lines}行`
  if (touch.reads > 0) return rangesText(touch)

  return ''
}

/** ファイル行の右端。 */
export function fileMeta(touch: TouchTreeTouch): string {
  const kind = kindOf(touch)

  if (kind === 'created') return touch.edits > 0 ? `新規 ✎${touch.edits}` : '新規'
  if (kind === 'edited') {
    const read = readText(touch)
    return read === '' ? `✎${touch.edits}` : `✎${touch.edits} ${read}`
  }
  if (kind === 'read' || kind === 'partial') return readText(touch)

  return touch.hits > 1 ? `検索×${touch.hits}` : '検索'
}

/** ディレクトリ行の右端。配下の件数と、そのうち書いたもの。 */
export function dirMeta(dir: Dir): string {
  return dir.edits > 0 ? `${dir.count} ✎${dir.edits}` : `${dir.count}`
}

/** 子が 1 つのディレクトリだけで、直下にファイルが無い間は 1 行につなげる。 */
function compress(dir: Dir): { dir: Dir; name: string } {
  let at = dir
  let name = `${dir.name}/`

  while (at.files.length === 0 && at.dirs.size === 1) {
    const only = [...at.dirs.values()][0]

    if (only === undefined) break

    at = only
    name += `${only.name}/`
  }

  return { dir: at, name }
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** dir の子を、罫線付きの行にして rows に足す（ディレクトリが先、それぞれ名前順）。 */
function pushChildren(rows: Row[], dir: Dir, guide: string, last: string | null): void {
  const dirs = [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))
  const files = [...dir.files].sort((a, b) => byName(a.name, b.name))
  const total = dirs.length + files.length
  let index = 0

  for (const child of dirs) {
    index += 1
    const isEnd = index === total
    const { dir: end, name } = compress(child)

    rows.push({ kind: 'dir', guide: guide + (isEnd ? '└ ' : '├ '), name, meta: dirMeta(end), path: end.path })
    pushChildren(rows, end, guide + (isEnd ? '  ' : '│ '), last)
  }

  for (const leaf of files) {
    index += 1
    const isEnd = index === total

    rows.push({
      kind: 'file',
      guide: guide + (isEnd ? '└ ' : '├ '),
      name: leaf.name,
      meta: fileMeta(leaf.touch),
      state: kindOf(leaf.touch),
      ...(leaf.path === last ? { isLast: true } : {}),
      path: leaf.path,
    })
  }
}

/**
 * 木を表示の行に平らにする。リポジトリの枝が先、外部の枝が後。
 */
export function rowsOf(forest: Forest, last: string | null): Row[] {
  const rows: Row[] = []

  if (forest.repo !== null) {
    rows.push({ kind: 'group', guide: '', name: `${forest.repo.name || '.'}/`, meta: dirMeta(forest.repo), path: '' })
    pushChildren(rows, forest.repo, '', last)
  }

  if (forest.external !== null) {
    rows.push({ kind: 'group', guide: '', name: EXTERNAL_LABEL, meta: dirMeta(forest.external), path: '' })
    pushChildren(rows, forest.external, '', last)
  }

  return rows
}

// ---- エディタで開くリンク ----

/** ファイルの行を押したときに開くエディタ。`off` ならリンクにしない。 */
export type Editor = 'vscode' | 'cursor' | 'idea' | 'off'

export const EDITORS: readonly Editor[] = ['vscode', 'cursor', 'idea', 'off']

/** 設定の値をエディタに直す。知らない値は既定（vscode）。 */
export function editorOf(value: unknown): Editor {
  return typeof value === 'string' && (EDITORS as readonly string[]).includes(value.trim()) ? (value.trim() as Editor) : 'vscode'
}

/** ファイルを開くリンクの URL。絶対パスでなければ、または `off` なら null。 */
export function editorUrl(editor: Editor, path: string): string | null {
  if (editor === 'off' || !path.startsWith('/')) return null
  if (editor === 'idea') return `idea://open?file=${encodeURIComponent(path)}`

  return `${editor}://file${encodeURI(path)}`
}

// ---- 表示幅 ----

/** 1 文字の表示幅（端末のセル数）。全角は 2、結合文字などは 0。 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

/** 文字列の表示幅。 */
export function textWidth(text: string): number {
  let width = 0

  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)

  return width
}

/** 先頭から width セルぶん（越えない範囲）。 */
function takeHead(text: string, width: number): string {
  let out = ''
  let used = 0

  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width) break
    out += ch
    used += w
  }

  return out
}

/** 末尾から width セルぶん（越えない範囲）。 */
function takeTail(text: string, width: number): string {
  const chars = [...text]
  let out = ''
  let used = 0

  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? ''
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width) break
    out = ch + out
    used += w
  }

  return out
}

/** 末尾を `…` で切る。 */
export function truncateEnd(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  if (width <= 0) return ''

  return takeHead(text, width - 1) + '…'
}

/** 先頭を `…` で切る（深いディレクトリは末尾のほうが手がかりになる）。 */
export function truncateStart(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  if (width <= 0) return ''

  return '…' + takeTail(text, width - 1)
}

/** 真ん中を `…` で切る（ファイル名は頭と拡張子を残す）。 */
export function truncateMiddle(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  if (width <= 2) return truncateEnd(text, width)

  const tail = Math.min(Math.floor((width - 1) / 2), 12)

  return takeHead(text, width - 1 - tail) + '…' + takeTail(text, tail)
}

/** 幅に収めた 1 行。width は 罫線 + 記号 + 名前 + (空白 + 補足) の合計。 */
export type FittedRow = Row & { symbol: string; width: number }

/** 状態ごとの記号。 */
export const SYMBOLS: Record<Kind, string> = {
  created: '✚',
  edited: '✎',
  read: '●',
  partial: '◐',
  hit: '○',
}

/** 名前に最低限残したい幅。 */
const NAME_MIN = 8

/**
 * 1 行を columns セルに収める。
 *
 * 補足は幅の 4 割まで（狭すぎれば出さない）。罫線が深すぎれば先頭を `…` にして末尾を残す。
 * ディレクトリ名は先頭を、ファイル名は真ん中を切る。
 */
export function fitRow(row: Row, columns: number): FittedRow {
  const cols = Math.max(1, Math.floor(columns))
  const symbol = row.kind === 'file' && row.state !== undefined ? `${SYMBOLS[row.state]} ` : ''
  const symbolWidth = textWidth(symbol)

  let meta = row.meta
  const metaRoom = cols < 20 ? 0 : Math.floor(cols * 0.4)

  if (textWidth(meta) > metaRoom) meta = metaRoom <= 3 ? '' : truncateEnd(meta, metaRoom)

  const metaWidth = (): number => (meta === '' ? 0 : 1 + textWidth(meta))

  let guide = row.guide
  const guideRoom = Math.max(0, cols - symbolWidth - Math.min(NAME_MIN, textWidth(row.name)) - metaWidth())

  if (textWidth(guide) > guideRoom) guide = guideRoom <= 1 ? '' : '…' + takeTail(guide, guideRoom - 1)

  let nameRoom = cols - textWidth(guide) - symbolWidth - metaWidth()

  if (nameRoom < Math.min(NAME_MIN, textWidth(row.name)) && meta !== '') {
    meta = ''
    nameRoom = cols - textWidth(guide) - symbolWidth
  }

  const name =
    row.kind === 'file' ? truncateMiddle(row.name, Math.max(0, nameRoom)) : truncateStart(row.name, Math.max(0, nameRoom))
  const width = textWidth(guide) + symbolWidth + textWidth(name) + (meta === '' ? 0 : 1 + textWidth(meta))

  return { ...row, guide, name, meta, symbol, width }
}
