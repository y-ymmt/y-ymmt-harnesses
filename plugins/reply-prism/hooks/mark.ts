// reply-prism 独自: 返事を書く Claude が `==…==` で囲んだ「特に注意すべき箇所」を見つける。純粋な関数だけ。
//
// 印は 1 行ずつ探す（行をまたぐ印は作らない）。段落・引用は行をつないでから文中の書式を読むので、
// 先に行ごとに見つけた印を私用領域の 2 文字に置き換えておき、markdown.ts がそれを 'mark' の節にする。

/** 見つけた印の始まりと終わりの代わりに置く文字（私用領域）。 */
export const MARK_OPEN = ''
export const MARK_CLOSE = ''
const SENTINELS = /[]/g

/** インラインコード（markdown.ts の INLINE と同じ形）。この中の `==`（`a == b` など）は印にしない。 */
const CODE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g

/**
 * `==中身==`。中身は空白で始まらず終わらない（`== ==` や `a == b == c` を拾わない）。
 * `===` の一部や、英数字に挟まれた `x==y` は印にしない。
 */
const MARK = /(?<![=A-Za-z0-9])==(?!=)(?=\S)(.*?\S)(?<!=)==(?![=A-Za-z0-9])/g

export type MarkRange = { start: number; end: number }

/** 1 行の中の印の位置（`==` を含む）。インラインコードの中は見ない。 */
export const findMarks = (line: string): MarkRange[] => {
  if (!line.includes('==')) return []
  // 同じ長さの、英数字でも空白でも `=` でもない文字で塗る（位置はそのまま、中の `==` は見えなくなる）。
  const masked = line.replace(CODE_SPAN, m => '\u0001'.repeat(m.length))
  return [...masked.matchAll(MARK)].map(m => ({ start: m.index, end: m.index + m[0].length }))
}

/** 1 行の印（`==x==`）それぞれを `wrap(x)` に置き換える。 */
const replaceMarks = (line: string, wrap: (inner: string) => string): string => {
  const marks = findMarks(line)
  if (marks.length === 0) return line
  let out = ''
  let at = 0
  for (const m of marks) {
    out += line.slice(at, m.start) + wrap(line.slice(m.start + 2, m.end - 2))
    at = m.end
  }
  return out + line.slice(at)
}

/** 1 行の印を私用領域の 2 文字に置き換える（markdown.ts が読む）。 */
export const markLine = (line: string): string => replaceMarks(line, inner => MARK_OPEN + inner + MARK_CLOSE)

/** 行ごとに印を置き換える。 */
export const markLines = (text: string): string => (text.includes('==') ? text.split('\n').map(markLine).join('\n') : text)

/** 1 行から印（`==`）を外す。中身は残す。 */
export const stripLine = (line: string): string => replaceMarks(line, inner => inner)

/** 行ごとに印を外す（リスト・引用のコピー用）。 */
export const stripMarks = (text: string): string => (text.includes('==') ? text.split('\n').map(stripLine).join('\n') : text)

/** 表の行から印を外す。セルごとに探す（描くときと同じく、`|` をまたぐ印は作らない）。 */
export const stripTable = (text: string): string =>
  text.includes('==') ? text.split('\n').map(line => line.split(/((?<!\\)\|)/).map(stripLine).join('')).join('\n') : text

/**
 * 1 行の印を別の記法に書き換える（返事まるごとコピー用。`**` を渡すと `==x==` → `**x**`）。
 * 中身に同じ記号があると入れ子で崩れるので、そのときは印を外すだけにする。表の行（`|` で始まる行）はセルごとに探す。
 */
export const rewriteMarks = (line: string, wrap: string): string => {
  if (!line.includes('==')) return line
  const one = (part: string): string => replaceMarks(part, inner => (wrap && !inner.includes(wrap) ? wrap + inner + wrap : inner))
  return /^\s*\|/.test(line) ? line.split(/((?<!\\)\|)/).map(one).join('') : one(line)
}

/** 対にならず残った置き換え文字を `==` に戻す（太字などの境目で印が割れたとき）。 */
export const restoreMarks = (text: string): string => text.replace(SENTINELS, '==')

/** 置き換え文字を消す（印の中身だけ残す）。 */
export const dropMarks = (text: string): string => text.replace(SENTINELS, '')

/**
 * reply-prism 独自の注記（`dangerHints`）。囲まれた箇所は危ない語と同じ見た目で描く（render.tsx の 'mark'）。
 * register.tsx が図の注記（HINT）と同じ仕組みで送信のたびに添える。モデルだけが読み、ユーザーには見えない。
 */
export const DANGER_HINT = [
  'This session draws ==text== in replies as a red warning highlight.',
  'Wrap only the few short phrases the reader must not miss: irreversible operations, production impact, data loss or bulk updates, security risks.',
  'Mark the key phrase, not a whole sentence, and at most a few per reply.',
  'Do not use it for ordinary emphasis (use **bold**), and never inside code blocks or inline code.',
].join(' ')
