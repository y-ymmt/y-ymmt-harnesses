/**
 * ツールの入力と出力から、触ったファイルの候補を拾う（純関数）。
 *
 * ここで拾うのは「候補」まで。実在するファイルかどうかは呼び出し側が `$.fs.stat` で確かめる。
 * macOS / Linux のネイティブ版には Grep・Glob ツールが無く、Claude は Bash の grep・find で
 * 探すので、Bash の読み取り系・検索系のコマンドも見る。
 */
import { normalizePath } from './record'
import type { Touching } from './record'

/** 中身を出すコマンド。引数のファイルを「読んだ」とみなす。 */
const WHOLE_READERS = new Set(['cat', 'bat', 'batcat', 'nl', 'less', 'more', 'view'])

/** 名前や一致行を出す検索コマンド。出力に出てきたファイルを「検索に出た」とみなす。 */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ugrep', 'ug', 'ag', 'ack', 'git-grep', 'find', 'fd', 'bfs'])

/** 中身に一致した行を見るもの（引数のファイルも検索に出たとみなす）。 */
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ugrep', 'ug', 'ag', 'ack', 'git-grep'])

/** 前に付いても中のコマンドは変わらないもの。 */
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'env'])

/** Bash 1 回ぶんの見立て。 */
export type BashPlan = {
  /** 読んだファイル（絶対パス）と範囲。 */
  reads: { path: string; from?: number; to?: number; whole: boolean }[]
  /** 検索コマンドに名指しされたファイル（実在を確かめてから hit にする）。 */
  named: string[]
  /** 出力からパスを拾う起点。検索コマンドが無ければ null。 */
  scanBase: string | null
}

/**
 * ヒアドキュメントの本文を外す（本文の `>` や `|` をコマンドと取り違えないため）。
 */
export function stripHeredocs(command: string): string {
  const out: string[] = []
  let end: string | undefined

  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined
      continue
    }

    out.push(line)
    const found = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)

    if (found !== null) end = found[2]
  }

  return out.join('\n')
}

/**
 * コマンド列を、区切り（`;` `&&` `||` `|` `&` 改行）ごとの語の並びに分ける。
 * 引用符の中は 1 語として扱い、引用符そのものは外す。`2>&1` の `&` は区切りにしない。
 */
export function segmentsOf(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''

    if (quote !== null) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i] ?? ''
      else word += c
      continue
    }

    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      const nextChar = command[++i] ?? ''

      if (nextChar !== '\n') {
        word += nextChar
        inWord = true
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '&' && (word.endsWith('>') || word.endsWith('<'))) {
      word += c
    } else if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      endSegment()
    } else {
      word += c
      inWord = true
    }
  }

  endSegment()

  return segments
}

/** リダイレクト（`>` `2>` `<` `>>` `2>&1` など）を、その行き先ごと外す。 */
function withoutRedirects(words: readonly string[]): string[] {
  const out: string[] = []

  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''

    if (/^\d*(>>?|<<?<?|&>)&?$/.test(w)) {
      i += 1
      continue
    }

    if (/^\d*(>>?|<<?<?|&>)/.test(w)) {
      continue
    }

    out.push(w)
  }

  return out
}

/** 先頭の `X=1` や sudo などを外し、コマンド名（basename）と引数に分ける。git grep は `git-grep`。 */
function commandOf(words: readonly string[]): { name: string; args: string[] } | undefined {
  let i = 0

  while (i < words.length) {
    const w = words[i] ?? ''

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1
    } else if (WRAPPERS.has(w)) {
      i += 1
    } else if (w === 'xargs') {
      // xargs の後ろのコマンドを本体とみなす（xargs 自身のオプションは飛ばす）。
      i += 1
      while (i < words.length && (words[i] ?? '').startsWith('-')) i += 1
    } else {
      break
    }
  }

  const head = words[i]

  if (head === undefined) {
    return undefined
  }

  const name = head.split('/').pop() ?? head
  const args = words.slice(i + 1)

  if (name === 'git') {
    const sub = args.findIndex(a => !a.startsWith('-'))

    if (sub >= 0 && args[sub] === 'grep') {
      return { name: 'git-grep', args: args.slice(sub + 1) }
    }
  }

  return { name, args }
}

/** `-n 20` `-n20` `-20` `--lines=20` から行数を読む（head）。無ければ 10。 */
function headCount(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const joined = /^-n(\d+)$/.exec(a) ?? /^--lines=(\d+)$/.exec(a) ?? /^-(\d+)$/.exec(a)

    if (joined !== null) return Number(joined[1])
    if (a === '-n' && /^\d+$/.test(args[i + 1] ?? '')) return Number(args[i + 1])
  }

  return 10
}

/** オペランド（オプションとその値を除いた引数）。値を取るオプションは takesValue で渡す。 */
function operandsOf(args: readonly string[], takesValue: ReadonlySet<string>): string[] {
  const out: string[] = []
  let rest = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''

    if (rest) {
      out.push(a)
    } else if (a === '--') {
      rest = true
    } else if (a.startsWith('-') && a !== '-') {
      if (takesValue.has(a)) i += 1
    } else {
      out.push(a)
    }
  }

  return out
}

/** sed のスクリプト `10,40p` `10p` から範囲を読む。読めなければ undefined。 */
function sedRange(script: string): { from: number; to: number } | undefined {
  const found = /^(\d+)(?:,(\d+))?p$/.exec(script.trim())

  if (found === null) {
    return undefined
  }

  const from = Number(found[1])
  const to = found[2] === undefined ? from : Number(found[2])

  return to >= from ? { from, to } : undefined
}

/**
 * Bash のコマンドから、読んだファイル・検索に名指しされたファイル・出力を読む起点を見立てる。
 *
 * `cd` は追いかけ、以降の相対パスはその先から解く。変数などで先が分からない cd の後は、
 * 相対パスを拾わない。
 *
 * @param command Bash に渡ったコマンド
 * @param cwd 実行した時点のシェルの作業ディレクトリ
 * @param home ホームディレクトリ
 */
export function planBash(command: string, cwd: string, home: string): BashPlan {
  const plan: BashPlan = { reads: [], named: [], scanBase: null }
  let base = cwd

  for (const raw of segmentsOf(stripHeredocs(command))) {
    const words = withoutRedirects(raw)
    const cmd = commandOf(words)

    if (cmd === undefined) continue

    const { name, args } = cmd
    const resolve = (p: string): string | undefined =>
      p.includes('$') || p.includes('*') || p.includes('?') ? undefined : normalizePath(p, base, home)

    if (name === 'cd' || name === 'pushd') {
      const to = args.find(a => !a.startsWith('-')) ?? '~'
      base = (to.includes('$') ? undefined : normalizePath(to, base, home)) ?? ''
      continue
    }

    if (WHOLE_READERS.has(name)) {
      for (const p of operandsOf(args, new Set())) {
        const path = resolve(p)
        if (path !== undefined) plan.reads.push({ path, whole: true })
      }
      continue
    }

    if (name === 'head') {
      const count = headCount(args)
      for (const p of operandsOf(args, new Set(['-n', '-c']))) {
        if (/^\d+$/.test(p)) continue
        const path = resolve(p)
        if (path !== undefined) plan.reads.push({ path, from: 1, to: count, whole: false })
      }
      continue
    }

    if (name === 'tail') {
      for (const p of operandsOf(args, new Set(['-n', '-c']))) {
        if (/^[+-]?\d+$/.test(p)) continue
        const path = resolve(p)
        if (path !== undefined) plan.reads.push({ path, whole: false })
      }
      continue
    }

    if (name === 'sed') {
      // 書き換え（-i）は読み取りとして数えない。
      if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) continue
      const quiet = args.some(a => /^-[a-zA-Z]*n/.test(a) || a === '--quiet' || a === '--silent')
      const scriptIndex = args.findIndex(a => a === '-e')
      const operands = operandsOf(args, new Set(['-e', '-f']))
      const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : operands.shift() ?? ''
      const range = quiet ? sedRange(script) : undefined

      for (const p of operands) {
        const path = resolve(p)
        if (path === undefined) continue
        plan.reads.push(range === undefined ? { path, whole: !quiet } : { path, ...range, whole: false })
      }
      continue
    }

    if (SEARCHERS.has(name)) {
      plan.scanBase = base === '' ? null : base

      if (GREPS.has(name)) {
        const takesValue = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t', '-T', '--glob', '--type', '--max-count'])
        for (const p of operandsOf(args, takesValue)) {
          const path = resolve(p)
          if (path !== undefined) plan.named.push(path)
        }
      }
    }
  }

  return plan
}

/**
 * grep・find などの出力 1 行から、パスらしい部分（の候補）を取り出す。
 *
 * - `path:12:中身`（grep -n）・`path-12-中身`（前後の行）・`path:中身`・`path`（-l や find）
 * - 行頭が空白の行や、区切りの `--` は捨てる
 */
export function pathsOfLine(line: string): string[] {
  const s = line.replace(/\r$/, '')

  if (s === '' || s === '--' || /^\s/.test(s) || s.length > 1024) {
    return []
  }

  const numbered = /^(.+?):\d+[:-]/.exec(s)

  if (numbered?.[1] !== undefined) {
    return [numbered[1]]
  }

  const out: string[] = []
  const colon = s.indexOf(':')
  const head = colon >= 0 ? s.slice(0, colon) : s

  if (head !== '' && !/\s{2,}|\t/.test(head)) out.push(head)

  // 前後の行（grep -C）は `path-12-中身`。ファイル名に `-数字-` を含むこともあるので候補を足すだけ。
  const context = /^(.+?)-\d+-/.exec(s)

  if (context?.[1] !== undefined && context[1] !== head) out.push(context[1])

  return out
}

/**
 * 検索コマンドの出力から、パスの候補（絶対パス）を重複なく拾う。
 *
 * @param limit 拾う候補の上限（確かめる `$.fs.stat` の数を抑えるため）
 */
export function outputCandidates(text: string, base: string, home: string, limit = 400): string[] {
  const found = new Set<string>()

  for (const line of text.slice(0, 500_000).split('\n').slice(0, 20_000)) {
    for (const head of pathsOfLine(line)) {
      const path = normalizePath(head, base, home)

      if (path !== undefined) found.add(path)
    }

    if (found.size >= limit) break
  }

  return [...found].slice(0, limit)
}

/**
 * LSP の結果の文章から、ファイルのパスらしい語（拡張子付き）を拾う。
 */
export function lspCandidates(text: string, base: string, home: string, limit = 200): string[] {
  const found = new Set<string>()
  const pattern = /(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}\b/g

  for (const match of text.slice(0, 200_000).matchAll(pattern)) {
    const path = normalizePath(match[0], base, home)

    if (path !== undefined) {
      found.add(path)
      if (found.size >= limit) break
    }
  }

  return [...found]
}

/**
 * Grep・Glob ツール（それらを持つ版）の結果から、パスの候補を拾う。
 *
 * `filenames`（files_with_matches・Glob）と、content モードの `content` の各行を見る。
 */
export function searchToolCandidates(result: unknown, text: string, base: string, home: string): string[] {
  const value = result as { filenames?: unknown; content?: unknown } | undefined
  const found = new Set<string>()

  if (value !== null && typeof value === 'object' && Array.isArray(value.filenames)) {
    for (const name of value.filenames.slice(0, 2000)) {
      if (typeof name !== 'string') continue
      const path = normalizePath(name, base, home)
      if (path !== undefined) found.add(path)
    }
  }

  const content = value !== null && typeof value === 'object' && typeof value.content === 'string' ? value.content : ''

  for (const path of outputCandidates(content, base, home)) found.add(path)
  if (found.size === 0) for (const path of outputCandidates(text, base, home)) found.add(path)

  return [...found]
}

/** BashPlan の読み取りを Touching に直す。 */
export function readsOf(plan: BashPlan): Touching[] {
  return plan.reads.map(r => ({
    path: r.path,
    read: r.from !== undefined && r.to !== undefined ? { from: r.from, to: r.to, whole: r.whole } : { whole: r.whole },
  }))
}
