// reply-prism 独自: 表の並べ替え（列の値の種類を見て比べる）と、コピー形式（Markdown・TSV・Slack）。
// 純粋な関数だけ。

import { width } from './width'

export type Align = 'left' | 'right' | 'center'
export type SortDir = 'asc' | 'desc'

// ---- 並べ替え ----

/** 空とみなす値。並べ替えではいつも最後に回す。 */
const PLACEHOLDER = /^(?:|-|–|—|―|N\/?A|n\/a|null|NULL|None|none|なし|無し|未定|不明|\?)$/

const SIZE: Record<string, number> = { b: 1, k: 1024, kb: 1024, kib: 1024, ki: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, mi: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, gi: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4, ti: 1024 ** 4 }
const TIME: Record<string, number> = { ms: 1, s: 1000, sec: 1000, 秒: 1000, m: 60_000, min: 60_000, 分: 60_000, h: 3_600_000, 時間: 3_600_000, d: 86_400_000, 日: 86_400_000 }

/** `1,234` `-5.2` `12%` `250ms` `3.5GB` `¥1,200` `42件` → 比べるための数。単位が時間・容量なら揃える。 */
export const parseNumber = (text: string): number | undefined => {
  const s = text.trim().replace(/^[¥$€£]\s*/, '').replace(/^−/, '-')
  const compound = /^(?:\d+(?:\.\d+)?\s*(?:ms|h|m|s|d)\s*){2,}$/i.test(s)
  if (compound) {
    let total = 0
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s|d)/gi)) total += Number(m[1]) * (TIME[m[2]!.toLowerCase()] ?? 1)
    return total
  }
  const m = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*([A-Za-z%]+|件|行|個|回|円|秒|分|時間|日|倍|人|台|本|社)?$/.exec(s)
  if (!m || (m[2] === undefined && m[3] === undefined)) return undefined
  const value = Number(`${m[1]}${(m[2] ?? '0').replace(/,/g, '')}${m[3] ?? ''}`)
  if (!Number.isFinite(value)) return undefined
  const unit = m[4] ?? ''
  const lower = unit.toLowerCase()
  if (unit === '' || unit === '%' || /^(?:件|行|個|回|円|倍|人|台|本|社|x)$/.test(unit)) return value
  if (TIME[unit] !== undefined) return value * TIME[unit]!
  if (TIME[lower] !== undefined && lower !== 'm') return value * TIME[lower]!
  if (SIZE[lower] !== undefined) return value * SIZE[lower]!
  if (lower === 'm') return value * 60_000
  return undefined
}

/** `2026-10-05` `2026/10/05 12:34:56` `2026-10-05T03:04:05Z` `2026年10月5日` `10/05 12:34` `12:34:56` → ミリ秒。 */
export const parseDate = (text: string): number | undefined => {
  const s = text.trim()
  const time = (h = '0', mi = '0', sec = '0', frac = '') => ((Number(h) * 60 + Number(mi)) * 60 + Number(sec)) * 1000 + Number((frac + '000').slice(0, 3))
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s)
  if (m) {
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const zone = m[8] && m[8] !== 'Z' ? (/^([+-])(\d{2}):?(\d{2})$/.exec(m[8]) ?? []) : []
    const offset = zone.length ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000 : 0
    return day + time(m[4], m[5], m[6], m[7]) - offset
  }
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})[時:](\d{1,2})分?(?:(\d{1,2})秒?)?)?$/.exec(s)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + time(m[4], m[5], m[6])
  m = /^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (m) return Date.UTC(2000, Number(m[1]) - 1, Number(m[2])) + time(m[3], m[4], m[5])
  m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/.exec(s)
  if (m) return time(m[1], m[2], m[3], m[4])
  return undefined
}

/** `v1.2.10` `2.1.289` `1.0.0-rc.1` → 数の並び。点が 2 つ以上か、`v` で始まるものだけ。 */
export const parseVersion = (text: string): { parts: number[]; pre: string } | undefined => {
  const m = /^[vV]?(\d+(?:\.\d+)+)(?:[-+]([\w.-]+))?$/.exec(text.trim())
  if (!m || (!/^[vV]/.test(text.trim()) && m[1]!.split('.').length < 3)) return undefined
  return { parts: m[1]!.split('.').map(Number), pre: m[2] ?? '' }
}

export type ColumnKind = 'number' | 'version' | 'date' | 'text'

/** 列の値の種類。空でない値がすべて同じ形のときだけ、その比べ方にする。 */
export const columnKind = (values: readonly string[]): ColumnKind => {
  const filled = values.map(v => v.trim()).filter(v => !PLACEHOLDER.test(v))
  if (filled.length === 0) return 'text'
  if (filled.every(v => parseNumber(v) !== undefined)) return 'number'
  if (filled.every(v => parseVersion(v) !== undefined)) return 'version'
  if (filled.every(v => parseDate(v) !== undefined)) return 'date'
  return 'text'
}

const collator = (() => {
  try {
    return new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
  } catch {
    return undefined
  }
})()

const compareText = (a: string, b: string) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0)

const compareVersion = (a: string, b: string): number => {
  const x = parseVersion(a)!
  const y = parseVersion(b)!
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return compareText(x.pre, y.pre)
}

/**
 * 並べ替えた後の行の順番（元の行番号の並び）。同じ値は元の順を保ち、空の値は昇順でも降順でも最後。
 */
export const sortOrder = (rows: readonly (readonly string[])[], col: number, dir: SortDir): number[] => {
  const values = rows.map(r => (r[col] ?? '').trim())
  const kind = columnKind(values)
  const compare = (a: string, b: string): number => {
    switch (kind) {
      case 'number':
        return parseNumber(a)! - parseNumber(b)!
      case 'date':
        return parseDate(a)! - parseDate(b)!
      case 'version':
        return compareVersion(a, b)
      case 'text':
        return compareText(a, b)
    }
  }
  const sign = dir === 'asc' ? 1 : -1
  return values
    .map((v, i) => ({ v, i, isEmpty: PLACEHOLDER.test(v) }))
    .sort((x, y) => {
      if (x.isEmpty !== y.isEmpty) return x.isEmpty ? 1 : -1
      if (x.isEmpty) return x.i - y.i
      return sign * compare(x.v, y.v) || x.i - y.i
    })
    .map(x => x.i)
}

/** 見出しを押したときの次の状態: なし → 昇順 → 降順 → なし。別の列を押したらその列の昇順から。 */
export const nextSort = (current: { col?: number; dir?: SortDir }, col: number): { col?: number; dir?: SortDir } => {
  if (current.col !== col || current.dir === undefined) return { col, dir: 'asc' }
  if (current.dir === 'asc') return { col, dir: 'desc' }
  return {}
}

// ---- コピー形式 ----

export const COPY_FORMATS = ['markdown', 'tsv', 'slack'] as const
export type CopyFormat = (typeof COPY_FORMATS)[number]

const alignRule = (a: Align) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---')

/** Markdown の表。セルは元の書き方のまま（`**太字**` なども残す）。 */
export const toMarkdown = (header: readonly string[], align: readonly Align[], rows: readonly (readonly string[])[]): string => {
  const line = (cells: readonly string[]) => `| ${header.map((_, c) => (cells[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(header), `| ${header.map((_, c) => alignRule(align[c] ?? 'left')).join(' | ')} |`, ...rows.map(line)].join('\n')
}

const oneLine = (s: string) => s.replace(/<br\s*\/?>/gi, ' ').replace(/[\t\r\n]+/g, ' ').trim()

/** TSV（タブ区切り）。Excel・Google スプレッドシートに貼ると 1 セルずつ入る。`"` を含むセルは `"` で囲む。 */
export const toTsv = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
  const cell = (s: string) => {
    const t = oneLine(s)
    return t.includes('"') ? `"${t.replace(/"/g, '""')}"` : t
  }
  return [header, ...rows].map(r => header.map((_, c) => cell(r[c] ?? '')).join('\t')).join('\n')
}

const pad = (s: string, w: number, a: Align) => {
  const room = Math.max(0, w - width(s))
  if (a === 'right') return ' '.repeat(room) + s
  if (a === 'center') return ' '.repeat(Math.floor(room / 2)) + s + ' '.repeat(room - Math.floor(room / 2))
  return s + ' '.repeat(room)
}

/**
 * Slack 向け。Slack は Markdown の表を描かないので、等幅のコードブロックに列を揃えて入れる。
 * 全角文字は 2 桁として揃える（Slack のフォントによっては少しずれる）。
 */
export const toSlack = (header: readonly string[], align: readonly Align[], rows: readonly (readonly string[])[]): string => {
  const all = [header, ...rows].map(r => header.map((_, c) => oneLine(r[c] ?? '')))
  const widths = header.map((_, c) => Math.max(1, ...all.map(r => width(r[c] ?? ''))))
  const line = (r: readonly string[]) => r.map((s, c) => pad(s, widths[c]!, align[c] ?? 'left')).join('  ').replace(/\s+$/, '')
  const [head, ...body] = all
  return ['```', line(head!), widths.map(w => '-'.repeat(w)).join('  '), ...body.map(line), '```'].join('\n')
}

export const COPY_LABEL: Record<CopyFormat, string> = { markdown: '⧉ Markdown', tsv: '⧉ TSV', slack: '⧉ Slack' }
export const COPY_DONE: Record<CopyFormat, string> = {
  markdown: 'Markdown の表としてコピーしました',
  tsv: 'TSV でコピーしました（Excel・スプレッドシートに貼れます）',
  slack: 'Slack 用（桁を揃えたコードブロック）でコピーしました',
}
