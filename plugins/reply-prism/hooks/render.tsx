// 本家 prismantis の hooks/render.tsx を元にした改変版。reply-prism で足したもの: 危ない語の強調（paint）、
// パスのリンク（linked）、表の並べ替え・折りたたみ・形式別コピー、コードの折りたたみ、ボタンの日本語化。
import type { ElementTable, RenderElement } from 'claude-code'

import type { Block, Inline } from './markdown'
import { inlineText, plainText } from './markdown'
import type { Range } from './danger'
import { dangerRanges, splitByRanges } from './danger'
import type { OpenTarget } from './paths'
import { isPathLike, openKey, openLabel } from './paths'
import { commentTail, commentVisual, flow, hasRtl } from './rtl'
import type { CopyFormat, SortDir } from './table'
import { COPY_DONE, COPY_LABEL, sortOrder, toMarkdown, toSlack, toTsv } from './table'
import type { Style, Theme } from './theme'
import type { PrismToken } from './vendor/prism.js'
import { languages, tokenize } from './vendor/prism.js'
import { width } from './width'

export { width }

// ---- reply-prism: 危ない語とファイルリンク ----

/** 危ない語の見た目。色が無い（mono）ときは反転＋太字。 */
const dangerProps = (style: Style) =>
  style.dangerBackground || style.dangerColor
    ? { bold: true, color: style.dangerColor, backgroundColor: style.dangerBackground }
    : { bold: true, inverse: true }

/**
 * `text` を 1 つの Text にする。危ない語があればその部分だけ強調した子に分ける。
 * `ranges` を渡すと、`offset` 文字目から始まる一片として切る（行全体で探した位置を使うとき）。
 */
const paint = (el: ElementTable, style: Style, text: string, key: string, props: Record<string, unknown>, mode: 'prose' | 'code', ranges?: readonly Range[], offset = 0): RenderElement => {
  const { Text } = el
  const found = ranges ?? dangerRanges(text, style.danger, mode)
  const pieces = found.length ? splitByRanges(text, found, offset) : []
  if (!pieces.some(p => p.isDanger)) return <Text key={key} {...props}>{text}</Text>
  return (
    <Text key={key} {...props}>
      {pieces.map((p, i) => (p.isDanger ? <Text key={`${key}.d${i}`} {...dangerProps(style)}>{p.text}</Text> : p.text))}
    </Text>
  )
}

/** 端末で描くときだけ、パスをエディタで開くリンクで包む。 */
const linked = (el: ElementTable, style: Style, target: string, child: RenderElement, key: string, isFile = false): RenderElement => {
  const href = style.fileLinks?.(target, isFile)
  if (!href) return child
  const { Link } = el
  return <Link key={key} href={href}>{child}</Link>
}

/** 返事の中の、リンクにしているのと同じファイルパス（文中・表のセル・パスだけのインラインコード）。同じパス＋行は 1 つに、出てきた順。 */
export const openTargets = (style: Style, blocks: readonly Block[]): OpenTarget[] => {
  const resolve = style.fileTargets
  if (!resolve) return []
  const found = new Map<string, OpenTarget>()
  const walk = (nodes: readonly Inline[]): void => {
    for (const n of nodes) {
      if ('children' in n) walk(n.children)
      else if (n.kind === 'path' || (n.kind === 'code' && isPathLike(n.text))) {
        const t = resolve(n.text)
        const id = t && `${t.line ?? 0}:${t.abs}`
        if (t && id && !found.has(id)) found.set(id, t)
      }
    }
  }
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
      case 'quote':
      case 'alert':
        walk(block.inline)
        break
      case 'list':
        for (const item of block.items) walk(item.inline)
        break
      case 'table':
        for (const cell of [...block.header, ...block.rows.flat()]) walk(cell)
        break
    }
  }
  return [...found.values()]
}

/** 返事の最後に足す「開く:」の行。押すとエディタで開くボタンを並べる（全画面表示の端末ではリンクのクリックが届かないため）。 */
export const renderOpenRow = (el: ElementTable, style: Style, blocks: readonly Block[]): RenderElement | null => {
  if (!style.openRow) return null
  const targets = openTargets(style, blocks)
  if (targets.length === 0) return null
  const { Box, Text, Button } = el
  const shown = targets.slice(0, style.openRowMax)
  const rest = targets.length - shown.length
  return (
    <Box key="open" flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text dimColor>開く:</Text>
      {shown.map(t => <Button key={openKey(t)} plain label={openLabel(t)} onPress={() => undefined} />)}
      {rest > 0 ? <Text dimColor>{`ほか ${rest} 件`}</Text> : null}
    </Box>
  )
}

/** 簡単なハッシュ。ブロックの開閉・並べ替えの状態を、ブロックの中身に結びつけるのに使う。 */
export const hashText = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

const flowOf = (style: Style, nodes: Inline[], columns: number) => (style.reorder ? flow(nodes, columns, width, style.shape) : null)

const renderInline = (el: ElementTable, style: Style, nodes: Inline[], keyBase: string): RenderElement[] => {
  const { Text } = el
  const t = style.theme
  return nodes.map((n, i) => {
    const key = `${keyBase}.${i}`
    switch (n.kind) {
      case 'text':
        return paint(el, style, n.text, key, {}, 'prose')
      case 'strong':
        return <Text key={key} bold color={t.strong}>{renderInline(el, style, n.children, key)}</Text>
      case 'emphasis':
        return <Text key={key} italic color={t.emphasis}>{renderInline(el, style, n.children, key)}</Text>
      case 'strike':
        return <Text key={key} strikethrough dimColor>{renderInline(el, style, n.children, key)}</Text>
      case 'code': {
        const code = paint(el, style, n.text, key, { color: t.inlineCode }, 'prose')
        return isPathLike(n.text) ? linked(el, style, n.text, code, `${key}.l`) : code
      }
      case 'link':
        return n.text === n.href
          ? <Text key={key} color={t.link} underline>{n.href}</Text>
          : <Text key={key}><Text color={t.link} underline>{n.text}</Text><Text dimColor> ({n.href})</Text></Text>
      case 'number':
        return <Text key={key} color={t.number}>{n.text}</Text>
      case 'path':
        return linked(el, style, n.text, paint(el, style, n.text, key, { color: t.path }, 'prose'), `${key}.l`)
      case 'dim':
        return <Text key={key} dimColor>{n.text}</Text>
    }
  })
}

const renderFlow = (el: ElementTable, style: Style, lines: Inline[][], key: string, props: { italic?: boolean; color?: string } = {}) => {
  const { Text } = el
  return lines.map((line, i) => <Text key={`${key}.${i}`} {...props}>{renderInline(el, style, line, `${key}.${i}`)}</Text>)
}

const PRISM_COLORS: Record<string, keyof Theme> = {
  comment: 'codeComment', prolog: 'codeComment', doctype: 'codeComment', cdata: 'codeComment',
  string: 'codeString', char: 'codeString', 'template-string': 'codeString', 'attr-value': 'codeString', url: 'codeString',
  number: 'number', boolean: 'number', constant: 'number', symbol: 'number', inserted: 'number',
  keyword: 'codeFlag', important: 'codeFlag', atrule: 'codeFlag', rule: 'codeFlag', deleted: 'codeFlag',
  function: 'codeCommand', 'class-name': 'codeCommand', builtin: 'codeCommand', key: 'codeCommand', selector: 'codeCommand',
  property: 'link', tag: 'link', 'attr-name': 'emphasis', variable: 'emphasis', regex: 'path',
}

type Segment = { text: string; color?: string; italic: boolean }

const flatten = (tokens: PrismToken[], style: Style, color?: string, italic = false): Segment[] =>
  tokens.flatMap(token => {
    if (typeof token === 'string') return [{ text: token, color, italic }]
    const names = [token.type, ...(Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [])]
    const slot = names.map(n => PRISM_COLORS[n]).find(Boolean)
    const inner = Array.isArray(token.content) ? token.content : [token.type === 'comment' && typeof token.content === 'string' && style.reorder ? commentVisual(token.content, style.shape) : token.content]
    return flatten(inner, style, slot ? style.theme[slot] : color, italic || token.type === 'comment')
  })

export const remember = <T,>(cache: Map<string, T>, key: string, make: () => T, limit = 200): T => {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = make()
  cache.set(key, value)
  if (cache.size > limit) cache.delete(cache.keys().next().value!)
  return value
}

const highlighted = new WeakMap<Style, Map<string, Segment[][]>>()

const grammarFor = (lang: string) => {
  const name = lang.toLowerCase()
  const grammar = Object.hasOwn(languages, name) ? languages[name] : undefined
  return grammar !== null && typeof grammar === 'object' ? grammar : undefined
}

export const highlightBlock = (el: ElementTable, style: Style, lines: string[], lang: string, key: string, limit = Infinity): RenderElement[] | null => {
  const { Text } = el
  const grammar = grammarFor(lang)
  if (!grammar) return null
  const code = lines.join('\n')
  const cache = highlighted.get(style) ?? new Map<string, Segment[][]>()
  highlighted.set(style, cache)
  const rows = remember(cache, `${lang}\0${code}`, () => {
    const out: Segment[][] = [[]]
    for (const seg of flatten(tokenize(code, grammar), style)) {
      seg.text.split('\n').forEach((piece, i) => {
        if (i > 0) out.push([])
        if (piece) out[out.length - 1]!.push({ ...seg, text: piece })
      })
    }
    return out
  })
  const mode = codeMode(lang)
  return rows.slice(0, limit).map((row, r) => {
    const ranges = dangerRanges(row.map(s => s.text).join(''), style.danger, mode)
    let offset = 0
    return (
      <Text key={`${key}.${r}`} color={style.theme.codeText}>
        {row.length
          ? row.map((s, i) => {
              const at = offset
              offset += s.text.length
              return paint(el, style, s.text, `${key}.${r}.${i}`, { color: s.color, italic: s.italic }, mode, ranges, at)
            })
          : ' '}
      </Text>
    )
  })
}

const isShellLang = (lang: string) => lang === '' || /^(sh|bash|zsh|shell|console|fish|powershell|ps1)$/i.test(lang)

/** シェルと SQL は大文字小文字を区別せずに危ない語を探す（`delete from` も当てる）。 */
const codeMode = (lang: string): 'prose' | 'code' => (isShellLang(lang) || /^(sql|mysql|pgsql|postgres(ql)?|plsql|tsql|sqlite)$/i.test(lang) ? 'code' : 'prose')

export const codeLine = (el: ElementTable, style: Style, line: string, lang: string, key: string): RenderElement => {
  const { Text } = el
  const t = style.theme
  const isShell = isShellLang(lang)
  if (/[\u2500-\u257F]/.test(line)) return <Text key={key} color={t.codeText}>{line}</Text>
  const comment = style.reorder ? commentTail(line, style.shape) : null
  if (comment) {
    return (
      <Text key={key} color={t.codeText}>
        {comment.head ? codeLine(el, style, comment.head, lang, `${key}.h`) : null}
        <Text color={t.codeComment}>{comment.marker + comment.tail}</Text>
      </Text>
    )
  }
  const mode = codeMode(lang)
  if (!isShell) return line ? paint(el, style, line, key, { color: t.codeText }, mode) : <Text key={key} color={t.codeText}>{' '}</Text>
  if (/^\s*#/.test(line)) return paint(el, style, line, key, { color: t.codeComment }, mode)
  const ranges = dangerRanges(line, style.danger, mode)
  const parts = line.split(/("[^"]*"|'[^']*'|\s+)/).filter(p => p !== '')
  let seenCommand = false
  let offset = 0
  return (
    <Text key={key} color={t.codeText}>
      {parts.map((p, i) => {
        const at = offset
        offset += p.length
        const part = (props: Record<string, unknown>) => paint(el, style, p, `${key}.${i}`, props, mode, ranges, at)
        if (/^\s+$/.test(p)) return part({})
        if (/^["']/.test(p)) return part({ color: t.codeString })
        if (/^--?[\w-]/.test(p)) return part({ color: t.codeFlag })
        if (!seenCommand && !/^[$>|&;]+$/.test(p)) {
          seenCommand = true
          return part({ color: t.codeCommand })
        }
        if (/^(\||&&|;|\|\|)$/.test(p)) seenCommand = false
        return part({})
      })}
    </Text>
  )
}

const columnWidths = (natural: number[], available: number, gap: number): number[] => {
  const room = Math.max(natural.length, available - gap * (natural.length - 1))
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= room) return natural
  const widths = natural.map(w => Math.max(1, Math.floor((w * room) / total)))
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 1) break
    widths[widest]!--
  }
  return widths
}

const displayText = (inline: Inline[]): string =>
  inline.map(n => (n.kind === 'link' && n.text !== n.href ? `${n.text} (${n.href})` : 'children' in n ? displayText(n.children) : n.text)).join('')

const isRtlTable = (style: Style, block: Extract<Block, { kind: 'table' }>): boolean => {
  const cells = [...block.header, ...block.rows.flat()].filter(cell => displayText(cell).trim() !== '')
  return cells.filter(cell => flowOf(style, cell, Infinity)?.base === 'R').length * 2 > cells.length
}

// reply-prism: 表・コードの開閉と並べ替えの状態（register.tsx が $.state から読んで渡す）。
export type BlockView = { open?: boolean; sortCol?: number; sortDir?: SortDir }
export type Controls = {
  /** このメッセージのブロックごとの状態。キーは blockId。 */
  view: Readonly<Record<string, BlockView>>
  toggle: (id: string) => void
  sort: (id: string, col: number) => void
}

/** ブロックの状態のキー。同じメッセージの中で、位置と中身が同じなら同じ。 */
export const blockId = (block: Block, b: number): string => `${b}.${hashText(block.raw)}`

const SORT_GLYPH = { none: '⇅', asc: '▲', desc: '▼' } as const

/** 畳める行数を超えているか。超えていれば見せない行の数。 */
const hiddenCount = (style: Style, controls: Controls | undefined, lines: number): number =>
  controls && style.fold.threshold > 0 && lines > style.fold.threshold ? lines - style.fold.preview : 0

const foldButton = (el: ElementTable, controls: Controls, id: string, key: string, hidden: number, isOpen: boolean): RenderElement => {
  const { Button } = el
  return <Button key={key} label={isOpen ? '畳む' : `あと ${hidden} 行を表示`} onPress={() => controls.toggle(id)} />
}

/** 表の行の並び。並べ替えていなければ元の順。 */
const tableOrder = (block: Extract<Block, { kind: 'table' }>, view: BlockView): number[] =>
  view.sortDir !== undefined && view.sortCol !== undefined && view.sortCol < block.header.length
    ? sortOrder(block.rows.map(r => r.map(c => plainText(c))), view.sortCol, view.sortDir)
    : block.rows.map((_, i) => i)

/** 表のコピー。並べ替えていればその順で（畳んでいても全行）。 */
const tableCopyText = (block: Extract<Block, { kind: 'table' }>, view: BlockView, format: CopyFormat): string => {
  const order = tableOrder(block, view)
  const isSorted = view.sortDir !== undefined
  switch (format) {
    case 'markdown':
      return isSorted ? toMarkdown(block.source.header, block.align, order.map(i => block.source.rows[i] ?? [])) : block.raw
    case 'tsv':
      return toTsv(block.header.map(plainText), order.map(i => (block.rows[i] ?? []).map(plainText)))
    case 'slack':
      return toSlack(block.header.map(plainText), block.align, order.map(i => (block.rows[i] ?? []).map(plainText)))
  }
}

const renderTable = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'table' }>, columns: number, key: string, id: string, controls?: Controls) => {
  const { Box, Text, Button } = el
  const t = style.theme
  const view = controls?.view[id] ?? {}
  const rtl = isRtlTable(style, block)
  const gap = style.tableStyle === 'grid' ? 3 : 2
  const isSortable = controls !== undefined && style.tableSort && block.rows.length >= 2
  const natural = block.header.map((h, c) =>
    Math.max(width(displayText(h)) + (isSortable ? 2 : 0), ...block.rows.map(r => width(displayText(r[c] ?? [])))),
  )
  const widths = columnWidths(natural, columns, gap)
  const order = natural.map((_, c) => c)
  if (rtl) order.reverse()
  const ruleChar = style.tableStyle === 'grid' ? '━' : '─'
  const justify = (c: number) =>
    block.align[c] === 'right' ? 'flex-end' : block.align[c] === 'center' ? 'center' : 'flex-start'

  const rule = (k: string, heavy: boolean) => (
    <Box key={k} flexDirection="row" columnGap={gap}>
      {order.map(c => (
        <Text key={`${k}.${c}`} color={t.tableRule} dimColor={!heavy && !t.tableRule}>
          {(heavy ? ruleChar : '─').repeat(widths[c]!)}
        </Text>
      ))}
    </Box>
  )

  const headerCell = (c: number, content: Inline[]) => {
    const label = <Text bold color={t.tableHeader}>{inlineText(content)}</Text>
    if (!isSortable || !controls) return label
    const dir = view.sortCol === c ? view.sortDir : undefined
    return (
      <Box flexDirection="row" columnGap={1}>
        {label}
        <Button key={`sort.${key}.${c}`} plain label={SORT_GLYPH[dir ?? 'none']} {...(dir ? {} : { dimColor: true })} onPress={() => controls.sort(id, c)} />
      </Box>
    )
  }

  const row = (cells: Inline[][], k: string, isHeader: boolean) => (
    <Box key={k} flexDirection="row" columnGap={gap}>
      {order.map(c => {
        const w = widths[c]!
        const cell = flowOf(style, cells[c] ?? [], Infinity)
        const content = cell ? cell.lines[0]! : (cells[c] ?? [])
        const side = cell?.base === 'R' && block.align[c] !== 'center' ? 'flex-end' : justify(c)
        return (
          <Box key={`${k}.${c}`} width={w} flexShrink={0} justifyContent={side}>
            {isHeader
              ? headerCell(c, content)
              : <Text>{renderInline(el, style, content, `${k}.${c}`)}</Text>}
          </Box>
        )
      })}
    </Box>
  )

  const rows = tableOrder(block, view)
  const hidden = hiddenCount(style, controls, rows.length)
  const shown = hidden && !view.open ? rows.slice(0, style.fold.preview) : rows
  const body: RenderElement[] = [row(block.header, `${key}.h`, true), rule(`${key}.hr`, true)]
  shown.forEach((r, i) => {
    body.push(row(block.rows[r] ?? [], `${key}.r${r}`, false))
    if (style.tableStyle !== 'minimal' && i < shown.length - 1) body.push(rule(`${key}.r${r}r`, false))
  })
  if (hidden && controls) body.push(<Box key={`${key}.fold`}>{foldButton(el, controls, id, `fold.${key}`, hidden, view.open === true)}</Box>)
  return <Box key={key} flexDirection="column" {...(rtl ? { alignSelf: 'flex-end' as const } : {})}>{body}</Box>
}

const renderHeading = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'heading' }>, key: string) => {
  const rtl = flowOf(style, block.inline, Infinity)
  if (!rtl) return drawHeading(el, style, block, block.inline, key)
  const heading = drawHeading(el, style, block, rtl.lines[0]!, key)
  return rtl.base === 'R' ? <el.Box key={key} alignSelf="flex-end">{heading}</el.Box> : heading
}

const drawHeading = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'heading' }>, inline: Inline[], key: string) => {
  const { Box, Text } = el
  const t = style.theme
  const color = block.level <= 2 ? t.heading : t.accent ?? t.heading
  const label = inlineText(inline)
  switch (style.headingStyle) {
    case 'uppercase':
      return <Text key={key} bold color={color}>{block.level === 1 ? label.toUpperCase() : label}</Text>
    case 'underline':
      return <Text key={key} bold underline={block.level <= 2} color={color}>{label}</Text>
    case 'banner':
      if (block.level === 1) return <Box key={key} alignSelf="flex-start" borderStyle="bold" borderColor={color} paddingX={1}><Text bold color={color}>{renderInline(el, style, inline, key)}</Text></Box>
      return block.level === 2
        ? <Box key={key} flexDirection="column" alignSelf="flex-start"><Text bold color={color}>{renderInline(el, style, inline, key)}</Text><Text color={color}>{'━'.repeat(width(label))}</Text></Box>
        : <Text key={key} bold color={block.level === 3 ? color : t.strong}>{renderInline(el, style, inline, key)}</Text>
    default:
      return <Text key={key} bold color={color}>{renderInline(el, style, inline, key)}</Text>
  }
}

const ALERT_COLOR = { note: 'blue', tip: 'green', important: 'magenta', warning: 'yellow', caution: 'red' } as const

const renderParagraph = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'paragraph' }>, columns: number, key: string) => {
  const { Box, Text } = el
  const rtl = flowOf(style, block.inline, columns)
  if (rtl?.base === 'R') return <Box key={key} flexDirection="column" alignItems="flex-end">{renderFlow(el, style, rtl.lines, key)}</Box>
  return <Text key={key}>{renderInline(el, style, rtl ? rtl.lines[0]! : block.inline, key)}</Text>
}

const renderQuote = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'quote' }>, columns: number, key: string) => {
  const { Box, Text } = el
  const t = style.theme
  const rtl = flowOf(style, block.inline, columns - 2)
  if (rtl?.base === 'R') {
    return (
      <Box key={key} flexDirection="row" justifyContent="flex-end">
        <Box flexDirection="column" alignItems="flex-end">{renderFlow(el, style, rtl.lines, key, { italic: true, color: t.quote })}</Box>
        <Text color={t.accent}> │</Text>
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="row">
      <Text color={t.accent}>│ </Text>
      <Text italic color={t.quote}>{renderInline(el, style, rtl ? rtl.lines[0]! : block.inline, key)}</Text>
    </Box>
  )
}

const renderAlert = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'alert' }>, columns: number, key: string) => {
  const { Box, Text } = el
  const color = ALERT_COLOR[block.level]
  const title = <Text bold color={color}>{block.level[0]!.toUpperCase() + block.level.slice(1)}</Text>
  const rtl = flowOf(style, block.inline, columns - 4)
  if (rtl?.base === 'R') {
    return (
      <Box key={key} flexDirection="column" alignSelf="flex-end" alignItems="flex-end" borderStyle="round" borderColor={color} paddingX={1}>
        {title}
        {renderFlow(el, style, rtl.lines, key)}
      </Box>
    )
  }
  const inline = rtl ? rtl.lines[0]! : block.inline
  return (
    <Box key={key} flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor={color} paddingX={1}>
      {title}
      {inline.length ? <Text>{renderInline(el, style, inline, key)}</Text> : null}
    </Box>
  )
}

const renderList = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'list' }>, columns: number, key: string) => {
  const { Box, Text } = el
  const t = style.theme
  return (
    <Box key={key} flexDirection="column">
      {block.items.map((item, i) => {
        const k = `${key}.${i}`
        const glyph = /\d/.test(item.marker) ? item.marker : item.depth ? '◦' : '•'
        const rtl = flowOf(style, item.inline, columns - item.depth * 2 - 2)
        if (rtl?.base === 'R') {
          return (
            <Box key={k} flexDirection="row" justifyContent="flex-end" paddingRight={item.depth * 2}>
              <Box flexDirection="column" alignItems="flex-end">{renderFlow(el, style, rtl.lines, k)}</Box>
              <Text color={t.bullet}>{` ${glyph}`}</Text>
            </Box>
          )
        }
        return (
          <Box key={k} flexDirection="row" paddingLeft={item.depth * 2}>
            <Text color={t.bullet}>{`${glyph} `}</Text>
            <Text>{renderInline(el, style, rtl ? rtl.lines[0]! : item.inline, k)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** コピーボタン。`text` は押されたときに作る関数でもよい（表の TSV・Slack 形式）。`done` は押した後のトースト。 */
export type CopyButton = (text: string | (() => string), key: string, label?: string, done?: string) => RenderElement | null

export const COPY = '⧉ コピー'
export type Drawn = Map<number, { element: RenderElement; art: string }>

/** 表の上に並べるボタン: 形式ごとのコピーと、開いているときの［畳む］。 */
const tableButtons = (el: ElementTable, style: Style, block: Extract<Block, { kind: 'table' }>, id: string, b: number, copy?: CopyButton, controls?: Controls): RenderElement | null => {
  const view = controls?.view[id] ?? {}
  const hidden = hiddenCount(style, controls, block.rows.length)
  const buttons = [
    ...(hidden && view.open && controls ? [foldButton(el, controls, id, `foldtop${b}`, hidden, true)] : []),
    ...style.tableCopyFormats.map(format => copy?.(() => tableCopyText(block, controls?.view[id] ?? {}, format), `copy${b}.${format}`, COPY_LABEL[format], COPY_DONE[format]) ?? null),
  ].filter((x): x is RenderElement => x !== null)
  if (buttons.length === 0) return null
  return <el.Box key={`copies${b}`} flexDirection="row" columnGap={1}>{buttons}</el.Box>
}

const copySource = (block: Block): string | undefined =>
  block.kind === 'code' ? block.lines.join('\n') : block.kind === 'table' || block.kind === 'list' ? block.raw : block.kind === 'quote' || block.kind === 'alert' ? block.raw.split('\n').map(line => line.replace(/^\s*>\s?/, '')).join('\n') : undefined

export const renderBlocks = (el: ElementTable, style: Style, blocks: Block[], columns: number, drawn: Drawn = new Map(), copy?: CopyButton, controls?: Controls): RenderElement[] => {
  const { Box, Text } = el
  const t = style.theme
  const ids = blocks.map(blockId)
  const rendered = blocks.map((block, b) => {
    const key = `b${b}`
    const id = ids[b]!
    switch (block.kind) {
      case 'heading':
        return renderHeading(el, style, block, key)
      case 'paragraph':
        return renderParagraph(el, style, block, columns, key)
      case 'quote':
        return renderQuote(el, style, block, columns, key)
      case 'alert':
        return renderAlert(el, style, block, columns, key)
      case 'rule':
        return <Text key={key} color={t.rule} dimColor={!t.rule}>{'─'.repeat(Math.max(8, Math.min(columns, 80)))}</Text>
      case 'code': {
        const done = drawn.get(b)?.element
        if (done) return done
        const hidden = hiddenCount(style, controls, block.lines.length)
        const isOpen = controls?.view[id]?.open === true
        const limit = hidden && !isOpen ? style.fold.preview : Infinity
        return (
          <Box key={key} flexDirection="column" alignSelf="flex-start">
            <Box flexDirection="row" justifyContent="space-between" columnGap={4}>
              <Text color={t.codeComment}>{`── ${block.lang || 'code'}${hidden ? ` · ${block.lines.length} 行` : ''}`}</Text>
              <Box flexDirection="row" columnGap={1}>
                {hidden && isOpen && controls ? foldButton(el, controls, id, `foldtop${b}`, hidden, true) : null}
                {copy?.(block.lines.join('\n'), `copy${b}`) ?? null}
              </Box>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {(isShellLang(block.lang) ? null : highlightBlock(el, style, block.lines, block.lang, key, limit)) ?? block.lines.slice(0, limit).map((line, i) => codeLine(el, style, line, block.lang, `${key}.${i}`))}
            </Box>
            {hidden && controls ? <Box paddingLeft={2}>{foldButton(el, controls, id, `fold${b}`, hidden, isOpen)}</Box> : null}
          </Box>
        )
      }
      case 'list':
        return renderList(el, style, block, columns, key)
      case 'table':
        return renderTable(el, style, block, columns, key, id, controls)
    }
  })
  const copied = rendered.map((element, b) => {
    const block = blocks[b]
    const text = block ? copySource(block) : undefined
    const isPlainCode = block?.kind === 'code' && !drawn.has(b)
    const art = drawn.get(b)?.art
    const button = text === undefined || isPlainCode ? null : block?.kind === 'table' ? tableButtons(el, style, block, ids[b]!, b, copy, controls) : art === undefined ? copy?.(text, `copy${b}`) : (
      <el.Box key={`copies${b}`} flexDirection="row" columnGap={1}>
        {copy?.(text, `copy${b}`, '⧉ ソース')}
        {copy?.(art, `art${b}`, '⧉ 図')}
      </el.Box>
    )
    if (!button) return element
    const { Box } = el
    const rtl = style.reorder && block !== undefined && hasRtl(block.raw)
    return block?.kind === 'quote' || block?.kind === 'alert' ? (
      <Box key={`c${b}`} flexDirection="row" columnGap={2} {...(rtl ? { justifyContent: 'flex-end' as const } : {})}>
        {element}
        {button}
      </Box>
    ) : (
      <Box key={`c${b}`} flexDirection="column" {...(rtl && (block?.kind === 'list' || (block?.kind === 'table' && isRtlTable(style, block))) ? {} : { alignSelf: 'flex-start' as const })}>
        <Box justifyContent="flex-end">{button}</Box>
        {element}
      </Box>
    )
  })
  const isFigure = (b: number) => blocks[b]?.kind === 'table' || drawn.has(b)
  const out: RenderElement[] = []
  for (let b = 0; b < rendered.length; b++) {
    if (!isFigure(b) || !isFigure(b + 1)) {
      out.push(copied[b]!)
      continue
    }
    const start = b
    while (isFigure(b + 1)) b++
    out.push(
      <Box key={`row${start}`} flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
        {copied.slice(start, b + 1).map((figure, i) => <Box key={`f${start + i}`} flexShrink={0}>{figure}</Box>)}
      </Box>,
    )
  }
  return out
}

export type ToolRow = { tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean }

const VERBS: Record<string, string> = {
  Bash: 'Ran', PowerShell: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited',
  Grep: 'Searched', Glob: 'Listed', WebFetch: 'Fetched', WebSearch: 'Searched the web for', Agent: 'Delegated', Task: 'Delegated',
}

const field = (input: unknown, ...keys: string[]): string | undefined => {
  if (input === null || typeof input !== 'object') return undefined
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

export const renderToolRow = (el: ElementTable, style: Style, row: ToolRow): RenderElement => {
  const { Box, Text, Button } = el
  const t = style.theme
  const isShell = row.tool === 'Bash' || row.tool === 'PowerShell'
  const verb = VERBS[row.tool] ?? row.tool.replace(/^mcp__([^_]+)__/, '$1 ')
  const target = isShell
    ? field(row.input, 'command')?.split('\n')[0]
    : field(row.input, 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description')
  const dot = row.isErrored ? t.codeFlag : row.isInterrupted ? t.codeComment : row.isRunning ? t.accent : t.number
  const isPath = target !== undefined && /^(~|\.{0,2}\/|[A-Za-z]:\\)/.test(target)
  const isFileTool = field(row.input, 'file_path', 'notebook_path') !== undefined
  const status = row.isInterrupted ? <Text dimColor> interrupted</Text> : row.isErrored ? <Text color={t.codeFlag}> failed</Text> : null
  const bullet = (
    <Box width={2} flexShrink={0}>
      <Text color={dot}>{row.isRunning ? '◌' : '●'}</Text>
    </Box>
  )

  // reply-prism: 端末ではファイルのパスを押して開くボタンにする（全画面表示ではリンクのクリックが届かないため）。
  const open = target !== undefined && isPath && isFileTool ? style.fileTargets?.(target, true) : undefined
  if (target !== undefined && open) {
    return (
      <Box flexDirection="row">
        {bullet}
        <Text bold>{verb}</Text>
        <Text> </Text>
        <Box flexShrink={1} minWidth={0}>
          <Button key={openKey(open)} plain label={target} onPress={() => undefined} />
        </Box>
        {status ? <Text wrap="truncate-end">{status}</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="row">
      {bullet}
      <Text wrap="truncate-end">
        <Text bold>{verb}</Text>
        {target === undefined ? null : <Text> </Text>}
        {target === undefined ? null : isShell ? codeLine(el, style, target, 'bash', 'cmd') : isPath && isFileTool ? linked(el, style, target, paint(el, style, target, 'target.t', { color: t.path }, 'prose'), 'target', true) : paint(el, style, target, 'target.t', { color: isPath ? t.path : t.inlineCode }, 'prose')}
        {status}
      </Text>
    </Box>
  )
}

const OUTPUT_LINES = 120

const lines = (value: unknown): string[] => (typeof value === 'string' && value !== '' ? value.replace(/\n$/, '').split('\n') : [])

export const renderExpandedShell = (el: ElementTable, style: Style, row: ToolRow & { output?: unknown }): RenderElement => {
  const { Box, Text } = el
  const t = style.theme
  const command = (field(row.input, 'command') ?? '').split('\n')
  const out = row.output !== null && typeof row.output === 'object' ? (row.output as Record<string, unknown>) : {}
  const stdout = lines(out.stdout)
  const stderr = lines(out.stderr)
  const shown = [...stdout.map(text => ({ text, color: undefined as string | undefined })), ...stderr.map(text => ({ text, color: t.codeFlag as string | undefined }))]
  const visible = shown.slice(0, OUTPUT_LINES)
  const dot = row.isErrored ? t.codeFlag : row.isInterrupted ? t.codeComment : row.isRunning ? t.accent : t.number
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={dot}>{row.isRunning ? '◌' : '●'}</Text>
        </Box>
        <Box flexDirection="column">
          {command.map((line, i) => (
            <Text key={`c${i}`}>
              {i === 0 ? <Text bold>{`${row.tool}(`}</Text> : null}
              {codeLine(el, style, line, 'bash', `cmd${i}`)}
              {i === command.length - 1 ? <Text bold>)</Text> : null}
            </Text>
          ))}
        </Box>
      </Box>
      {row.isRunning ? null : (
        <Box paddingLeft={2}>
          <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor={t.codeComment} paddingX={1}>
            {visible.length === 0 ? <Text dimColor>(No output)</Text> : visible.map((l, i) => <Text key={`o${i}`} color={l.color}>{l.text === '' ? ' ' : l.text}</Text>)}
            {shown.length > visible.length ? <Text dimColor>{`\u2026 +${shown.length - visible.length} lines`}</Text> : null}
          </Box>
        </Box>
      )}
    </Box>
  )
}

const GROUPS: [RegExp, string, string][] = [
  [/^(Bash|PowerShell)$/, 'ran', 'command'],
  [/^Read$/, 'read', 'file'],
  [/^(Write|Edit|MultiEdit|NotebookEdit)$/, 'edited', 'file'],
  [/^(Grep|Glob)$/, 'searched', 'pattern'],
  [/^(WebFetch|WebSearch)$/, 'fetched', 'page'],
  [/^(Agent|Task)$/, 'delegated', 'task'],
]

export const groupSummary = (calls: readonly { tool: string }[]): string => {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const [, verb, noun] = GROUPS.find(([re]) => re.test(call.tool)) ?? [, 'used', call.tool.replace(/^mcp__([^_]+)__/, '$1 ')]
    const label = `${verb} ${noun}`
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts].map(([label, n]) => {
    const [verb, ...noun] = label.split(' ')
    const name = noun.join(' ')
    return `${verb} ${n} ${n === 1 ? name : name.endsWith('h') ? `${name}es` : `${name}s`}`
  })
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const renderToolGroup = (el: ElementTable, style: Style, calls: readonly ToolRow[], isActive: boolean): RenderElement => {
  const { Box, Text } = el
  const t = style.theme
  const failed = calls.filter(c => c.isErrored).length
  const running = isActive && calls.some(c => c.isRunning)
  const dot = failed ? t.codeFlag : running ? t.accent : t.number
  const last = calls[calls.length - 1]
  const lastTarget = last ? field(last.input, 'command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description')?.split('\n')[0] : undefined
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={dot}>{running ? '◌' : '●'}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text bold>{groupSummary(calls)}</Text>
        {failed ? <Text color={t.codeFlag}>{` · ${failed} failed`}</Text> : null}
        {lastTarget ? <Text dimColor>{' · last: '}{paint(el, style, lastTarget, 'last', {}, 'code')}</Text> : null}
      </Text>
    </Box>
  )
}

export const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(s, 0)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export const renderTurnDuration = ({ Text }: ElementTable, style: Style, word: string, durationMs: number): RenderElement => (
  <Text color={style.theme.codeComment}>
    {`✻ ${word} for `}
    <Text color={style.theme.number}>{formatDuration(durationMs)}</Text>
  </Text>
)
