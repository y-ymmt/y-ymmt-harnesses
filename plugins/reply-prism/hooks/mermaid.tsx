import type { ElementTable, RenderElement } from 'claude-code'

import { remember } from './render'
import type { Style } from './theme'
import { renderMermaidAscii, setChartSize } from './vendor/mermaid-text.js'
import { width } from './width'

const MAX_LINES = 80
const textCache = new Map<string, string | null>()

export const chartSize = (columns: number, source = '') => {
  const labels = (/^\s*x-axis\b[^[\n]*\[([^\]\n]*)\]/m.exec(source)?.[1] ?? '').split(',').map(s => s.trim().replace(/^"|"$/g, ''))
  const fit = labels.length * (Math.max(...labels.map(l => l.length)) + 2)
  const chartWidth = Math.max(24, Math.min(60, Math.max(Math.floor(columns / 6), fit), columns - 12))
  const base = Math.max(8, Math.min(20, Math.round(chartWidth * 0.3)))
  return { width: chartWidth, height: source === '' ? base : evenHeight(source, base) }
}

// reply-prism: 縦軸の目盛りは値を行に丸めて置くので、グラフの高さによっては 2 つの目盛りが同じ行に重なって
// 片方が消えたり（80 が無い）、間が 1 行空いたりする。目盛りが重ならず、なるべく等間隔に並ぶ高さを選ぶ。
// 目盛りと縦軸の範囲の求め方は、同梱の beautiful-mermaid（niceTickValues と parseXYChart）と同じにしてある。
const niceTicks = (min: number, max: number): number[] => {
  const range = max - min
  if (!(range > 0)) return [min]
  const raw = range / 6
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const residual = raw / magnitude
  const step = (residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10) * magnitude
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e10) / 1e10)
  return ticks
}

const yRangeOf = (source: string): { min: number; max: number } | null => {
  const given = /^\s*y-axis\s+(?:"[^"]*"\s+)?(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)/m.exec(source)
  if (given) return { min: parseFloat(given[1]!), max: parseFloat(given[2]!) }
  const values = [...source.matchAll(/^\s*(?:bar|line)\s+\[([^\]]+)\]/gm)].flatMap(m => m[1]!.split(',').map(v => parseFloat(v.trim())))
  if (values.length === 0 || values.some(v => !Number.isFinite(v))) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  let min = lo - span * 0.1
  if (min > 0 && min < span * 0.5) min = 0
  return { min, max: hi + span * 0.1 }
}

export const evenHeight = (source: string, base: number): number => {
  const range = yRangeOf(source)
  if (range === null || /^\s*xychart(-beta)?\s+horizontal/m.test(source)) return base
  const ticks = niceTicks(range.min, range.max)
  if (ticks.length < 2) return base
  let best = base
  let bestScore = Infinity
  for (let h = 8; h <= 24; h++) {
    const rows = ticks.map(v => Math.round(((v - range.min) / (range.max - range.min || 1)) * (h - 1))).filter(r => r >= 0 && r < h)
    if (new Set(rows).size !== rows.length || rows.length < ticks.length) continue
    const gaps = rows.slice(1).map((r, i) => r - rows[i]!)
    const unevenness = Math.max(...gaps) - Math.min(...gaps)
    const score = unevenness * 100 + Math.abs(h - base)
    if (score < bestScore) {
      bestScore = score
      best = h
    }
  }
  return best
}

const unquoteCategories = (source: string) =>
  source.replace(/^(\s*x-axis\b[^[\n]*\[)([^\]\n]*)\]/m, (_, head: string, items: string) => `${head}${items.replace(/"([^"]*)"/g, (_q, s: string) => s.replaceAll(',', ' '))}]`)

const labelBars = (art: string, source: string): string => {
  const series = source.match(/^\s*(bar|line)\b.*$/gm) ?? []
  const values = /^\s*bar\b[^[\n]*\[([^\]\n]*)\]/m.exec(source)?.[1]?.split(',').map(v => v.trim())
  if (series.length !== 1 || !values || /^\s*xychart(-beta)?\s+horizontal/m.test(source)) return art
  const grid = art.split('\n').map(l => [...l])
  const axis = grid.findLastIndex(row => row.includes('┬'))
  const ticks = grid[axis]?.flatMap((ch, x) => (ch === '┬' ? [x] : [])) ?? []
  if (ticks.length !== values.length) return art
  ticks.forEach((x, k) => {
    const top = grid.findIndex(row => row[x] === '█')
    const y = top === -1 ? axis - 1 : top - 1
    const text = [...values[k]!]
    const from = x - Math.floor((text.length - 1) / 2)
    const row = grid[y]
    if (!row || y < 0) return
    while (row.length < from + text.length) row.push(' ')
    if (!text.every((_, i) => /[ ·]/.test(row[from + i] ?? ' '))) return
    text.forEach((ch, i) => (row[from + i] = ch))
  })
  return grid.map(row => row.join('').trimEnd()).join('\n')
}

// reply-prism: beautiful-mermaid は全角の文字も 1 マスと数えるので、日本語のラベルだと箱の右端や線がずれる。
// 描く前に全角の文字を「目印 + 埋め草」の 2 文字（私用領域、どちらも 1 マス）に置き換えて幅を正しく取らせ、
// 描いたあとで目印を元の文字に戻し、埋め草を消す。
const MARK_BASE = 0xe000
const MARK_LIMIT = 0xf000
const FILLER = '\uf8ff'

const widen = (source: string): { text: string; wide: string[] } | null => {
  const wide: string[] = []
  let text = ''
  for (const ch of source) {
    if (width(ch) !== 2) {
      text += ch
      continue
    }
    let i = wide.indexOf(ch)
    if (i < 0) {
      i = wide.push(ch) - 1
      if (MARK_BASE + i >= MARK_LIMIT) return null
    }
    text += String.fromCharCode(MARK_BASE + i) + FILLER
  }
  return { text, wide }
}

const narrow = (art: string, wide: readonly string[]): string =>
  wide.length === 0
    ? art
    : art.replace(/[\ue000-\uefff]\uf8ff?/g, m => wide[m.charCodeAt(0) - MARK_BASE] ?? m).replaceAll(FILLER, ' ')

export const mermaidText = (source: string, ascii: boolean, columns: number): string | null => {
  if (/[\ue000-\uefff\uf8ff]/.test(source)) return mermaidNarrowText(source, ascii, columns)
  const widened = widen(source)
  if (widened === null) return mermaidNarrowText(source, ascii, columns)
  const art = mermaidNarrowText(widened.text, ascii, columns)
  return art === null ? null : narrow(art, widened.wide)
}

/** 全角を考えない元の描き方（本家のまま）。 */
const mermaidNarrowText = (source: string, ascii: boolean, columns: number): string | null => {
  if (source.length > 8000 || source.split('\n').length > MAX_LINES) return null
  const isChart = /^\s*xychart/.test(source)
  const size = chartSize(columns, isChart ? source : '')
  const key = `${ascii}:${isChart ? size.width : 0}:${source}`
  return remember(textCache, key, () => {
    try {
      if (isChart) setChartSize(size.width, size.height)
      const art = renderMermaidAscii(unquoteCategories(source.replace(/^(\s*%%[^\n]*\n)+/, '')).replace(/(-->|-\.->|==>|---|-\.-|===)[ \t]+\|/g, '$1|'), { useAscii: ascii, colorMode: 'none', paddingX: 3, paddingY: 1 }).replace(/[ \t]+$/gm, '').trimEnd()
      return isChart ? labelBars(art, source) : art.split('\n').filter(l => !/^[\s│|]*$/.test(l)).join('\n')
    } catch {
      return null
    }
  })
}

const LINE = /[─-╿◇]/
const ARROW = /[►◄▲▼▶◀]/

const paint = (art: string, style: Style): (string | undefined)[][] => {
  const t = style.theme
  const grid = art.split('\n').map(l => [...l])
  const cell = (r: number, c: number) => grid[r]?.[c] ?? ''
  const color: (string | undefined)[][] = grid.map(row => row.map(() => undefined))
  const palette = [...new Set([t.link, t.number, t.heading, t.emphasis, t.path, t.codeFlag, t.accent])].filter((c): c is string => c !== undefined)
  const next = (i: number) => palette[i % palette.length]
  const labels = new Map<string, string | undefined>()

  const rects: { r: number; c: number; r2: number; c2: number }[] = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (!/[┌╭(]/.test(cell(r, c))) continue
      let c2 = c + 1
      while (/[─┬┴┼▲▼]/.test(cell(r, c2))) c2++
      if (!/[┐╮)]/.test(cell(r, c2)) || c2 === c + 1) continue
      let r2 = r + 1
      while (/[│├┤┼►◄▶◀]/.test(cell(r2, c))) r2++
      if (!/[└╰(]/.test(cell(r2, c)) || !/[┘╯)]/.test(cell(r2, c2))) continue
      rects.push({ r, c, r2, c2 })
    }
  }
  const inside = (a: (typeof rects)[number], b: (typeof rects)[number]) => a !== b && b.r > a.r && b.r2 < a.r2 && b.c > a.c && b.c2 < a.c2
  for (const box of rects.filter(a => !rects.some(b => inside(a, b)))) {
    const { r, c, r2, c2 } = box
    const label = grid.slice(r + 1, r2).map(row => row.slice(c + 1, c2).join('')).join(' ').trim()
    if (!labels.has(label)) labels.set(label, next(labels.size))
    const hue = labels.get(label)
    for (let y = r; y <= r2; y++) for (let x = c; x <= c2; x++) if (cell(y, x).trim()) color[y]![x] = hue
  }

  const bars = [...new Set(grid.flatMap(row => row.flatMap((ch, c) => (ch === '█' && row[c - 1] !== '█' ? [c] : []))))].sort((a, b) => a - b)
  const ticks = grid.findLast(row => row.includes('┬'))?.filter(ch => ch === '┬').length ?? 0
  const tops = bars.map(x => grid.findIndex(row => row[x] === '█'))
  const single = bars.length > 1 && bars.length <= ticks
  const barColor = (i: number) => (single ? (tops[i] === Math.min(...tops) ? t.emphasis ?? t.accent : t.quote) : next(i))
  grid.forEach((row, r) =>
    row.forEach((ch, c) => {
      if (color[r]![c] !== undefined) return
      if (ch === '█') {
        let start = c
        while (row[start - 1] === '█') start--
        color[r]![c] = barColor(bars.indexOf(start))
      } else if (ch === '·') color[r]![c] = t.rule
      else if (ARROW.test(ch)) color[r]![c] = t.accent
      else if (LINE.test(ch)) color[r]![c] = t.diagram
      else if (/^\d+[┤┼]/.test(row.slice(c).join(''))) color[r]![c] = t.number
      else color[r]![c] = t.diagramText
    }),
  )
  return color
}

const painted = new WeakMap<Style, Map<string, (string | undefined)[][]>>()

export const boxArt = ({ Box, Text }: ElementTable, style: Style, art: string, key: string): RenderElement => {
  const cache = painted.get(style) ?? new Map<string, (string | undefined)[][]>()
  painted.set(style, cache)
  const colors = remember(cache, art, () => paint(art, style))
  return (
    <Box key={key} flexDirection="column" paddingLeft={2}>
      {art.split('\n').map((line, i) => {
        const chars = [...line]
        const parts: RenderElement[] = []
        let at = 0
        while (at < chars.length) {
          const hue = colors[i]?.[at]
          let end = at + 1
          while (end < chars.length && colors[i]?.[end] === hue) end++
          parts.push(<Text key={`t${parts.length}`} color={hue}>{chars.slice(at, end).join('')}</Text>)
          at = end
        }
        return <Text key={`${key}.${i}`}>{parts.length ? parts : ' '}</Text>
      })}
    </Box>
  )
}
