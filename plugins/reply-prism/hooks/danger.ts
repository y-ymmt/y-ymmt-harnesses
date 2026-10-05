// reply-prism 独自: `本番` `DELETE` `rm -rf` などの危ない語を見つける。純粋な関数だけ。

export const DEFAULT_DANGER_WORDS = [
  '本番', 'production', 'prod',
  'DELETE', 'UPDATE', 'DROP', 'TRUNCATE', 'ALTER',
  '--force', '--hard', 'rm -rf', 'rm -fr',
] as const

/**
 * 語の一覧の書き方: カンマ・読点・改行で区切る（`rm -rf` のように空白を含む語があるため、空白では区切らない）。
 */
export const parseWords = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(/[,、\n]/).map(w => w.trim()).filter(w => w !== '') : []

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ALNUM_START = /^[A-Za-z0-9]/
const ALNUM_END = /[A-Za-z0-9]$/

/** 1 語ぶんの正規表現。英数字で始まる/終わる語は、前後が英数字でないときだけ当たる（`prod` は `product` に当たらない）。 */
const termSource = (word: string): string => {
  const body = word.split(/\s+/).map(escape).join(String.raw`\s+`)
  return `${ALNUM_START.test(word) ? '(?<![A-Za-z0-9])' : ''}${body}${ALNUM_END.test(word) ? '(?![A-Za-z0-9])' : ''}`
}

const build = (words: readonly string[], flags: string): RegExp | null => {
  if (words.length === 0) return null
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length)
  return new RegExp(sorted.map(termSource).join('|'), flags)
}

/**
 * 文中用と、コード（SQL・シェル・ツールのコマンド）用の 2 組。
 *
 * - 文中: 大文字を含む語（`DELETE`）は大文字小文字を区別する（英文の "delete the file" に当てないため）。
 *   小文字だけの語（`production`）は区別しない
 * - コード: すべて区別しない（`delete from users` も当てる）
 */
export type DangerMatchers = { sensitive: RegExp | null; insensitive: RegExp | null; code: RegExp | null }

export const buildDanger = (words: readonly string[]): DangerMatchers => {
  const hasUpper = (w: string) => /[A-Z]/.test(w)
  return {
    sensitive: build(words.filter(hasUpper), 'g'),
    insensitive: build(words.filter(w => !hasUpper(w)), 'gi'),
    code: build(words, 'gi'),
  }
}

export type Range = { start: number; end: number }

const collect = (text: string, re: RegExp | null, out: Range[]) => {
  if (!re) return
  for (const m of text.matchAll(re)) if (m[0] !== '') out.push({ start: m.index, end: m.index + m[0].length })
}

/** 危ない語の位置。重なりはまとめ、先頭から順に並べる。 */
export const dangerRanges = (text: string, matchers: DangerMatchers | null, mode: 'prose' | 'code'): Range[] => {
  if (!matchers || text === '') return []
  const found: Range[] = []
  if (mode === 'code') collect(text, matchers.code, found)
  else {
    collect(text, matchers.sensitive, found)
    collect(text, matchers.insensitive, found)
  }
  found.sort((a, b) => a.start - b.start)
  const merged: Range[] = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

export type Piece = { text: string; isDanger: boolean }

/** `text`（行の `offset` 文字目から始まる一片）を、危ない語の位置で切り分ける。 */
export const splitByRanges = (text: string, ranges: readonly Range[], offset = 0): Piece[] => {
  const end = offset + text.length
  const out: Piece[] = []
  let at = offset
  for (const r of ranges) {
    if (r.end <= at || r.start >= end) continue
    const s = Math.max(r.start, at)
    const e = Math.min(r.end, end)
    if (s > at) out.push({ text: text.slice(at - offset, s - offset), isDanger: false })
    out.push({ text: text.slice(s - offset, e - offset), isDanger: true })
    at = e
  }
  if (at < end) out.push({ text: text.slice(at - offset), isDanger: false })
  return out
}
