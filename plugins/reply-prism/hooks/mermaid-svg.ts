// reply-prism: デスクトップアプリで mermaid を SVG で描く。デスクトップは Text を文字ごとに幅の違うフォントで描くので、
// 文字の格子で組んだ罫線の図は桁がずれて崩れる。SVG なら位置を座標で決められるのでずれない。
// - sequenceDiagram と xychart は beautiful-mermaid の SVG（vendor/mermaid-svg.js）
// - それ以外（flowchart など。beautiful-mermaid の SVG は配置に elkjs を使い同梱できない）は、
//   端末用に描いた罫線の図の格子を、線は線分、文字はマスの位置に置いた text にして SVG にする
import type { Style } from './theme'
import { renderMermaidSvg } from './vendor/mermaid-svg.js'
import { width } from './width'

export type MermaidSvg = { source: string; width: number; height: number }

/** 1 マスの幅と高さ（px）。幅は 14px の等幅フォントの送り（0.6em）で、ふつうの字の並びはこれより狭い。 */
const CW = 8.4
const CH = 18
const PAD = 8
const FONT_SIZE = 14

const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** テーマの色を SVG で使える色に。ansi256(…) など CSS に無い書き方は fallback にする。 */
const cssColor = (c: string | undefined, fallback: string): string =>
  c !== undefined && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(c.trim()) ? c.trim() : fallback

/** #rgb / #rrggbb の明るい色か（それ以外の書き方は暗い色とみなす）。 */
const isLight = (c: string): boolean => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1]
  if (!hex) return false
  const full = hex.length === 3 ? [...hex].map(h => h + h).join('') : hex
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 140
}

/** 外部のフォントを読みに行かないよう、beautiful-mermaid が入れる @import を外す。 */
const stripImports = (svg: string) => svg.replace(/^\s*@import url\([^)]*\);\s*$/gm, '')

/** sequenceDiagram と xychart を beautiful-mermaid で SVG に。ほかの図や描けないときは null。 */
export const chartSvg = (source: string, style: Style): MermaidSvg | null => {
  const t = style.theme
  try {
    const fg = cssColor(t.diagramText ?? t.codeText, '#1f2328')
    // 背景は描かない（transparent）が、ラベルの下地と色の混ぜ合わせに使うので、文字が明るい配色なら暗い色にする
    const svg = renderMermaidSvg(source, { bg: isLight(fg) ? '#1e1e2e' : '#ffffff', fg, line: cssColor(t.diagram, '#57606a'), accent: cssColor(t.accent ?? t.diagram, '#57606a') }, 'system-ui')
    if (svg === null) return null
    const size = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
    if (!size) return null
    return { source: stripImports(svg), width: Math.ceil(parseFloat(size[1]!)), height: Math.ceil(parseFloat(size[2]!)) }
  } catch {
    return null
  }
}

type Dir = 'n' | 'e' | 's' | 'w'
/** 罫線の文字 → マスの中心から伸びる向き。 */
const LINES: Record<string, Dir[]> = {
  '─': ['e', 'w'], '═': ['e', 'w'], '╌': ['e', 'w'], '┄': ['e', 'w'], '┈': ['e', 'w'],
  '│': ['n', 's'], '║': ['n', 's'], '╎': ['n', 's'], '┆': ['n', 's'], '┊': ['n', 's'],
  '┌': ['e', 's'], '╭': ['e', 's'], '┐': ['w', 's'], '╮': ['w', 's'],
  '└': ['n', 'e'], '╰': ['n', 'e'], '┘': ['n', 'w'], '╯': ['n', 'w'],
  '├': ['n', 'e', 's'], '╟': ['n', 'e', 's'], '┤': ['n', 'w', 's'], '╢': ['n', 'w', 's'],
  '┬': ['e', 'w', 's'], '┴': ['e', 'w', 'n'], '┼': ['n', 'e', 's', 'w'],
  '╵': ['n'], '╷': ['s'], '╴': ['w'], '╶': ['e'],
}
const DASHED = /[╌┄┈╎┆┊]/
/** 矢印の文字 → 向き。 */
const ARROWS: Record<string, Dir> = { '▲': 'n', '▼': 's', '►': 'e', '▶': 'e', '▷': 'e', '◄': 'w', '◀': 'w', '◁': 'w' }
const OPPOSITE: Record<Dir, Dir> = { n: 's', s: 'n', e: 'w', w: 'e' }

/**
 * 罫線の図（mermaidText の出力）を SVG に。colors は paint の結果（行・文字ごとの色）。
 * 全角の文字は格子で 2 マスを占めるので、マスの位置は表示幅で数える。
 */
export const artSvg = (art: string, colors: (string | undefined)[][], style: Style): MermaidSvg => {
  const t = style.theme
  const textColor = cssColor(t.diagramText ?? t.codeText, '#1f2328')
  const lineColor = cssColor(t.diagram, '#57606a')
  const rows = art.split('\n').map(line => {
    let col = 0
    return [...line].map((ch, i) => {
      const cell = { ch, col, span: width(ch), i }
      col += cell.span
      return cell
    })
  })
  const at = (r: number, col: number) => rows[r]?.find(c => c.col <= col && col < c.col + c.span)?.ch ?? ' '
  const reaches = (r: number, col: number, d: Dir) => {
    const ch = at(r, col)
    return (LINES[ch]?.includes(d) ?? false) || ARROWS[ch] === OPPOSITE[d]
  }
  const cols = Math.max(1, ...rows.map(row => row.reduce((w, c) => w + c.span, 0)))
  const x0 = (col: number) => PAD + col * CW
  const y0 = (r: number) => PAD + r * CH

  const lines = new Map<string, string[]>()
  const dashes = new Map<string, string[]>()
  const fills = new Map<string, string[]>()
  const texts: string[] = []
  const push = (m: Map<string, string[]>, color: string, d: string) => m.set(color, [...(m.get(color) ?? []), d])

  rows.forEach((row, r) => {
    // 文字は続き（同じ色で、間の空白が 1 つまで）ごとに 1 つの text にし、そのマスの範囲の真ん中に置く。
    // 1 文字ずつマスに置くと、全角の字間が開きすぎて読みにくい。等幅で組んだ範囲より字の並びのほうが狭いので、箱からははみ出ない。
    const runs: { color: string; from: number; to: number; text: string }[] = []
    for (const { ch, col, span, i } of row) {
      const color = colors[r]?.[i]
      const cx = x0(col) + (span * CW) / 2
      const cy = y0(r) + CH / 2
      const ends: Record<Dir, string> = { n: `M${cx} ${cy}V${y0(r)}`, s: `M${cx} ${cy}V${y0(r) + CH}`, e: `M${cx} ${cy}H${x0(col) + span * CW}`, w: `M${cx} ${cy}H${x0(col)}` }
      const dirs = LINES[ch]
      if (dirs) {
        for (const d of dirs) push(DASHED.test(ch) ? dashes : lines, cssColor(color, lineColor), ends[d])
        continue
      }
      const arrow = ARROWS[ch]
      if (arrow) {
        // 矢じりは隣のマスの中心（箱の枠の線）まで伸ばし、反対側は線をマスの端まで延ばしてつなぐ。
        const fill = cssColor(color, lineColor)
        push(lines, lineColor, ends[OPPOSITE[arrow]])
        const h = 4
        const tri =
          arrow === 's' ? `M${cx - h} ${cy - 1}L${cx + h} ${cy - 1}L${cx} ${y0(r) + CH * 1.5}Z`
          : arrow === 'n' ? `M${cx - h} ${cy + 1}L${cx + h} ${cy + 1}L${cx} ${y0(r) - CH / 2}Z`
          : arrow === 'e' ? `M${cx - 1} ${cy - h}L${cx - 1} ${cy + h}L${x0(col) + CW * 1.5} ${cy}Z`
          : `M${cx + 1} ${cy - h}L${cx + 1} ${cy + h}L${x0(col) - CW / 2} ${cy}Z`
        push(fills, fill, tri)
        continue
      }
      if (ch === '◇') {
        for (const d of ['n', 'e', 's', 'w'] as const) {
          const [dr, dc] = d === 'n' ? [-1, 0] : d === 's' ? [1, 0] : d === 'e' ? [0, span] : [0, -1]
          if (reaches(r + dr, col + dc, OPPOSITE[d])) push(lines, cssColor(color, lineColor), ends[d])
        }
        texts.push(`<path d="M${cx} ${cy - 4}L${cx + 4} ${cy}L${cx} ${cy + 4}L${cx - 4} ${cy}Z" fill="none" stroke="${escapeXml(cssColor(color, lineColor))}" stroke-width="1.2"/>`)
        continue
      }
      if (ch === '█') {
        push(fills, cssColor(color, lineColor), `M${x0(col)} ${y0(r)}h${span * CW}v${CH}h${-span * CW}Z`)
        continue
      }
      if (ch === '·') {
        push(fills, cssColor(color, '#d0d7de'), `M${cx - 0.8} ${cy}a0.8 0.8 0 1 0 1.6 0a0.8 0.8 0 1 0 -1.6 0Z`)
        continue
      }
      if (ch.trim() === '') continue
      const fill = cssColor(color, textColor)
      const last = runs[runs.length - 1]
      if (last && last.color === fill && col - last.to <= 1) {
        last.text += ' '.repeat(col - last.to) + ch
        last.to = col + span
      } else runs.push({ color: fill, from: col, to: col + span, text: ch })
    }
    for (const run of runs) {
      const x = (x0(run.from) + x0(run.to)) / 2
      texts.push(`<text x="${x.toFixed(1)}" y="${(y0(r) + CH / 2).toFixed(1)}" fill="${escapeXml(run.color)}">${escapeXml(run.text)}</text>`)
    }
  })

  const w = Math.ceil(PAD * 2 + cols * CW)
  const h = Math.ceil(PAD * 2 + rows.length * CH)
  const paths = (m: Map<string, string[]>, attrs: string) => [...m].map(([color, ds]) => `<path d="${ds.join('')}" ${attrs.replace('$', escapeXml(color))}/>`)
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    ...paths(lines, 'fill="none" stroke="$" stroke-width="1.2" stroke-linecap="square"'),
    ...paths(dashes, 'fill="none" stroke="$" stroke-width="1.2" stroke-dasharray="3 3"'),
    ...paths(fills, 'fill="$"'),
    // 文字の書式は style 要素でなく属性で（同じ文書に置かれたほかの SVG に効かないように）
    `<g font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${FONT_SIZE}" dominant-baseline="central" text-anchor="middle" xml:space="preserve">`,
    ...texts,
    '</g></svg>',
  ].join('')
  return { source, width: w, height: h }
}
