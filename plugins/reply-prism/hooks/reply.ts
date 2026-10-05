// reply-prism 独自: 返事まるごとコピー。返事（ユーザーの 1 回の依頼に対する Claude の返事）の全テキストを集め、
// 貼り先（Markdown・GitHub・Slack・Notion）に合う形に書き直す。Slack は mrkdwn の文字と、書式付きで貼る HTML・プレーンテキスト。
// 純粋な関数だけ。
//
// 1 回の返事はツール呼び出しを挟んで複数のテキストブロック（AssistantMessage）に分かれる。描画には自分のブロックの
// 文しか来ないので、register.tsx が `$.session.messages()` で会話を読み、findReply でそのブロックが入る返事を探す。

import type { AlertLevel, Block, Inline } from './markdown'
import { parse, parseInline, plainText } from './markdown'
import { rewriteMarks } from './mark'
import { toSlack } from './table'

// ---- 返事を集める ----

/** `$.session.messages()` の 1 行のうち、ここで使うもの。 */
export type TranscriptRow = { role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[] }

/**
 * 会話を返事ごとに分ける。ツールの結果ではない、文のあるユーザーの行（依頼・コマンド・通知）で区切り、
 * 返事ごとに Claude の文のある行の文を並べる（考えている途中だけの行・ツール呼び出しだけの行は文が空なので入らない）。
 */
export const splitReplies = (rows: readonly TranscriptRow[]): string[][] => {
  const replies: string[][] = []
  let current: string[] | undefined
  for (const row of rows) {
    if (row.role === 'user') {
      if (!row.toolResults?.length && row.text.trim() !== '') {
        current = []
        replies.push(current)
      }
      continue
    }
    if (row.text.trim() === '') continue
    if (!current) {
      current = []
      replies.push(current)
    }
    current.push(row.text)
  }
  return replies
}

/** 同じ会話（使い回している配列）を描画のたびに分け直さない。 */
const split = new WeakMap<readonly TranscriptRow[], string[][]>()
const repliesOf = (rows: readonly TranscriptRow[]): string[][] => {
  const hit = split.get(rows)
  if (hit) return hit
  const replies = splitReplies(rows)
  split.set(rows, replies)
  return replies
}

export type FoundReply = {
  /** その返事のテキストブロックの文。出てきた順。 */
  texts: string[]
  /** 描いているブロックが、その返事の最後のテキストブロックか。 */
  isLast: boolean
  /** その返事が会話の最後の返事か（ターンの途中なら、まだ続きが来るかもしれない）。 */
  isLatest: boolean
}

/**
 * 描いているブロックの文（`AssistantMessage` の `text`）が入る返事を探す。まず文が同じ行、無ければ文を含む行
 * （描く側が一部を隠した文）。同じ文が何度も出てくるときは一番新しいもの。見つからなければ undefined。
 */
export const findReply = (rows: readonly TranscriptRow[], text: string): FoundReply | undefined => {
  const target = text.trim()
  if (target === '') return undefined
  const replies = repliesOf(rows)
  const hits = (match: (t: string) => boolean) =>
    replies.flatMap((texts, r) => texts.flatMap((t, k) => (match(t.trim()) ? [{ r, k }] : [])))
  const exact = hits(t => t === target)
  const hit = (exact.length ? exact : hits(t => t.includes(target))).at(-1)
  if (!hit) return undefined
  const texts = replies[hit.r]!
  const own = texts[hit.k]!.trim()
  return {
    texts,
    // 1 行に文のブロックが 2 つあるとき（含むで当たったとき）は、行の終わりのブロックだけを最後とみなす。
    isLast: hit.k === texts.length - 1 && own.endsWith(target),
    isLatest: hit.r === replies.length - 1,
  }
}

// ---- 形式 ----

export const REPLY_FORMATS = ['markdown', 'github', 'slack', 'notion'] as const
export type ReplyFormat = (typeof REPLY_FORMATS)[number]

export const REPLY_LABEL: Record<ReplyFormat, string> = { markdown: 'Markdown', github: 'GitHub', slack: 'Slack', notion: 'Notion' }
/** Slack 用を書式付き（HTML）でクリップボードに入れられたときのトースト。入れられず文字だけのときは REPLY_DONE。 */
export const REPLY_DONE_RICH = 'Slack 用にコピーしました（書式付き）'
export const REPLY_DONE: Record<ReplyFormat, string> = {
  markdown: 'Markdown でコピーしました',
  github: 'GitHub 用にコピーしました',
  slack: 'Slack 用にコピーしました（文字だけ）',
  notion: 'Notion 用にコピーしました',
}

const ALERT_LABEL: Record<AlertLevel, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }
const ALERT_EMOJI: Record<AlertLevel, string> = { note: 'ℹ️', tip: '💡', important: '❗', warning: '⚠️', caution: '🛑' }
const ALERT_SLACK: Record<AlertLevel, string> = { note: ':information_source:', tip: ':bulb:', important: ':exclamation:', warning: ':warning:', caution: ':octagonal_sign:' }

// ---- 元の Markdown を行ごとに書き直す（Markdown・GitHub・Notion） ----

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/
const QUOTE = /^\s*>/
const ALERT_LINE = /^(\s*)>\s?\[!(note|tip|important|warning|caution)\]\s*(.*)$/i
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

type LineRules = {
  /** `==x==` を何で囲むか（'' なら印を外すだけ）。 */
  mark: string
  /** 囲み（`> [!NOTE]`）の 1 行目の書き直し。undefined ならそのまま。 */
  alert?: (level: AlertLevel, indent: string, rest: string) => string
  /** 見出しの書き直し。undefined ならそのまま。 */
  heading?: (level: number, text: string, line: string) => string
}

/** コードブロックの外の行だけを書き直す（markdown.ts の parse と同じ囲みの見分け方）。コードの中は書かれたまま。 */
const rewriteLines = (source: string, rules: LineRules): string => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let closer: RegExp | undefined
  let wasQuote = false
  for (const line of lines) {
    if (closer) {
      out.push(line)
      if (closer.test(line)) closer = undefined
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const run = fence[1] ?? '```'
      closer = new RegExp(`^\\s*\\${run[0]}{${run.length},}\\s*$`)
      out.push(line)
      wasQuote = false
      continue
    }
    const isQuote = QUOTE.test(line)
    const alert = rules.alert && isQuote && !wasQuote ? ALERT_LINE.exec(line) : null
    wasQuote = isQuote
    if (alert) {
      out.push(rules.alert!(alert[2]!.toLowerCase() as AlertLevel, alert[1] ?? '', rewriteMarks(alert[3] ?? '', rules.mark)))
      continue
    }
    const heading = rules.heading ? HEADING.exec(line) : null
    if (heading) {
      out.push(rules.heading!(heading[1]!.length, rewriteMarks(heading[2] ?? '', rules.mark), rewriteMarks(line, rules.mark)))
      continue
    }
    out.push(rewriteMarks(line, rules.mark))
  }
  return out.join('\n')
}

const alertQuote = (label: string, indent: string, rest: string) => `${indent}> ${label}` + (rest ? `\n${indent}> ${rest}` : '')

/** 汎用の Markdown: 印は外し、GitHub の囲みはどこでも読める `> **Note**` に。 */
export const toReplyMarkdown = (source: string): string =>
  rewriteLines(source, { mark: '', alert: (level, indent, rest) => alertQuote(`**${ALERT_LABEL[level]}**`, indent, rest) })

/** GitHub（GFM）: 囲み・表・mermaid・コードの言語名はそのまま。印は太字に。 */
export const toReplyGitHub = (source: string): string => rewriteLines(source, { mark: '**' })

/**
 * Notion: 貼ると見出し・リスト・コード・表・引用になる Markdown。囲みは絵文字とラベルの引用に、印は太字に。
 * Notion の見出しは 3 段までなので、`####` 以下は太字の 1 行にする。
 */
export const toReplyNotion = (source: string): string =>
  rewriteLines(source, {
    mark: '**',
    alert: (level, indent, rest) => alertQuote(`${ALERT_EMOJI[level]} **${ALERT_LABEL[level]}**`, indent, rest),
    heading: (level, text, line) => (level <= 3 ? line : text.includes('**') ? text : `**${text}**`),
  })

// ---- Slack（mrkdwn）: 読んだブロックから書き出す ----

const NO_HIGHLIGHT = { numbers: false, paths: false }

/** 文中の書式を Slack の記法に。`bold` は太字の中（見出し・太字の入れ子で `*` を重ねない）。 */
const slackInline = (nodes: readonly Inline[], bold = false): string =>
  nodes
    .map(n => {
      switch (n.kind) {
        case 'strong':
        case 'mark':
          return bold ? slackInline(n.children, true) : `*${slackInline(n.children, true)}*`
        case 'emphasis':
          return `_${slackInline(n.children, bold)}_`
        case 'strike':
          return `~${slackInline(n.children, bold)}~`
        case 'code':
          return `\`${n.text}\``
        case 'link':
          // `<url|text>` は貼り付けた入力欄では書式にならず記号が残るので、どこでも読める `text (url)` に。
          return n.text === n.href ? n.href : `${n.text} (${n.href})`
        default:
          return n.text
      }
    })
    .join('')

/** 段落・引用は行ごとに読む（Slack では改行がそのまま改行になるため、行をつながない）。 */
const slackLines = (lines: readonly string[], prefix = ''): string =>
  lines.map(line => (line.trim() === '' ? prefix.trimEnd() : prefix + slackInline(parseInline(line.trim(), NO_HIGHLIGHT)))).join('\n')

const unquote = (raw: string): string[] => raw.split('\n').map(line => line.replace(/^\s*>\s?/, ''))

const slackBlock = (block: Block): string => {
  switch (block.kind) {
    case 'heading':
      return `*${slackInline(block.inline, true)}*`
    case 'paragraph':
      return slackLines(block.raw.split('\n'))
    case 'list':
      return block.items.map(item => `${'    '.repeat(item.depth)}${/\d/.test(item.marker) ? item.marker : '•'} ${slackInline(item.inline)}`).join('\n')
    case 'code':
      return ['```', ...block.lines, '```'].join('\n')
    case 'quote':
      return slackLines(unquote(block.raw), '> ')
    case 'alert': {
      const [first = '', ...rest] = unquote(block.raw)
      const after = first.replace(/^\s*\[![a-z]+\]\s*/i, '')
      return [`> ${ALERT_SLACK[block.level]} *${ALERT_LABEL[block.level]}*`, ...(after ? [slackLines([after], '> ')] : []), ...(rest.length ? [slackLines(rest, '> ')] : [])].join('\n')
    }
    case 'rule':
      return '────────'
    case 'table':
      return toSlack(block.header.map(plainText), block.align, block.rows.map(r => r.map(plainText)))
  }
}

/**
 * Slack（mrkdwn）: `*太字*` `_斜体_` `~取り消し~` `` `code` ``、言語名なしのコードブロック（mermaid も図のソースのまま）、
 * リンクは `text (url)`、見出しは太字の 1 行、リストは `•`（入れ子は字下げ）、番号付きは番号のまま、
 * 表は桁を揃えたコードブロック（表のコピーの Slack と同じ）、囲みは `>` に絵文字とラベル、印は太字。
 */
export const toReplySlack = (source: string): string => parse(source, NO_HIGHLIGHT).map(slackBlock).join('\n\n')

// ---- Slack（書式付き）: HTML とプレーンテキスト ----
// Slack の入力欄は貼り付けた文字の mrkdwn を解釈しないが、Web ページからコピーしたときと同じ HTML の書式付きテキストなら
// 太字・リスト・コード・リンクが書式になる。macOS では register.tsx がこの HTML と、書式記号の無いプレーンテキストを
// クリップボードに入れる（clipboard.ts）。

/** HTML の特殊文字を文字参照に。 */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'))

/** リンクにする URL（http・https・mailto だけ。ほかは文字で `text (url)`）。 */
const SAFE_HREF = /^(?:https?:|mailto:)/i

/** 文中の書式を HTML に。`bold` は太字の中（`<b>` を重ねない）。 */
const htmlInline = (nodes: readonly Inline[], bold = false): string =>
  nodes
    .map(n => {
      switch (n.kind) {
        case 'strong':
        case 'mark':
          return bold ? htmlInline(n.children, true) : `<b>${htmlInline(n.children, true)}</b>`
        case 'emphasis':
          return `<i>${htmlInline(n.children, bold)}</i>`
        case 'strike':
          return `<s>${htmlInline(n.children, bold)}</s>`
        case 'code':
          return `<code>${escapeHtml(n.text)}</code>`
        case 'link':
          return SAFE_HREF.test(n.href) ? `<a href="${escapeHtml(n.href)}">${escapeHtml(n.text)}</a>` : escapeHtml(plainText([n]))
        default:
          return escapeHtml(n.text)
      }
    })
    .join('')

/** 段落・引用は行ごとに読み、`<br>` でつなぐ（mrkdwn と同じく、改行は改行のまま）。 */
const htmlLines = (lines: readonly string[]): string => lines.map(line => (line.trim() === '' ? '' : htmlInline(parseInline(line.trim(), NO_HIGHLIGHT)))).join('<br>')

/** 入れ子のリスト。深さが飛んでいたら 1 段ずつ、同じ深さで記号と番号が入れ替わったら別のリストにする。 */
const htmlList = (items: Extract<Block, { kind: 'list' }>['items']): string => {
  const out: string[] = []
  const open: ('ul' | 'ol')[] = []
  const start = (tag: 'ul' | 'ol', marker: string) => {
    const n = Number.parseInt(marker, 10)
    out.push(tag === 'ol' && Number.isFinite(n) && n !== 1 ? `<ol start="${n}">` : `<${tag}>`)
    open.push(tag)
  }
  for (const item of items) {
    const tag = /\d/.test(item.marker) ? 'ol' : 'ul'
    const depth = Math.min(item.depth, open.length)
    if (depth === open.length) {
      start(tag, item.marker)
    } else {
      while (open.length > depth + 1) out.push(`</li></${open.pop()}>`)
      out.push('</li>')
      if (open[depth] !== tag) {
        out.push(`</${open.pop()}>`)
        start(tag, item.marker)
      }
    }
    out.push(`<li>${htmlInline(item.inline)}`)
  }
  while (open.length) out.push(`</li></${open.pop()}>`)
  return out.join('')
}

/** 表は Slack に無いので、mrkdwn と同じ桁を揃えた等幅の文（コードブロックの中身）にする。 */
const alignedTable = (block: Extract<Block, { kind: 'table' }>): string =>
  toSlack(block.header.map(plainText), block.align, block.rows.map(r => r.map(plainText))).split('\n').slice(1, -1).join('\n')

const htmlBlock = (block: Block): string => {
  switch (block.kind) {
    case 'heading':
      return `<p><b>${htmlInline(block.inline, true)}</b></p>`
    case 'paragraph':
      return `<p>${htmlLines(block.raw.split('\n'))}</p>`
    case 'list':
      return htmlList(block.items)
    case 'code':
      return `<pre>${escapeHtml(block.lines.join('\n'))}</pre>`
    case 'quote':
      return `<blockquote>${htmlLines(unquote(block.raw))}</blockquote>`
    case 'alert': {
      const [first = '', ...rest] = unquote(block.raw)
      const after = first.replace(/^\s*\[![a-z]+\]\s*/i, '')
      const body = [...(after ? [after] : []), ...rest]
      return `<blockquote>${ALERT_EMOJI[block.level]} <b>${ALERT_LABEL[block.level]}</b>${body.length ? `<br>${htmlLines(body)}` : ''}</blockquote>`
    }
    case 'rule':
      return '<p>────────</p>'
    case 'table':
      return `<pre>${escapeHtml(alignedTable(block))}</pre>`
  }
}

/**
 * Slack に貼る HTML: 見出しは太字の段落、`<b>` `<i>` `<s>` `<code>`、コードブロックは言語名なしの `<pre>`（mermaid もソース）、
 * リンクは `<a href>`、リストは入れ子の `<ul>` `<ol>`、引用は `<blockquote>`、囲みは絵文字と太字のラベルつきの引用、
 * 表は桁を揃えた `<pre>`、印は太字。文字はすべてエスケープする。
 */
/**
 * ブロックの間に挟む空行。Slack は貼られた HTML の段落の余白を詰め、隣り合う `<pre>` どうし・`<blockquote>` どうしを
 * 1 つにまとめてしまうので、空の段落で区切る（表とコード、囲みと引用が混ざらないように）。
 */
export const SLACK_BLOCK_GAP = '<p><br></p>'

export const toReplySlackHtml = (source: string): string => parse(source, NO_HIGHLIGHT).map(htmlBlock).join(SLACK_BLOCK_GAP)

const plainLines = (lines: readonly string[], prefix = ''): string =>
  lines.map(line => (line.trim() === '' ? prefix.trimEnd() : prefix + plainText(parseInline(line.trim(), NO_HIGHLIGHT)))).join('\n')

const plainBlock = (block: Block): string => {
  switch (block.kind) {
    case 'heading':
      return plainText(block.inline)
    case 'paragraph':
      return plainLines(block.raw.split('\n'))
    case 'list':
      return block.items.map(item => `${'    '.repeat(item.depth)}${/\d/.test(item.marker) ? item.marker : '•'} ${plainText(item.inline)}`).join('\n')
    case 'code':
      return block.lines.join('\n')
    case 'quote':
      return plainLines(unquote(block.raw), '> ')
    case 'alert': {
      const [first = '', ...rest] = unquote(block.raw)
      const after = first.replace(/^\s*\[![a-z]+\]\s*/i, '')
      return [`> ${ALERT_EMOJI[block.level]} ${ALERT_LABEL[block.level]}`, ...(after || rest.length ? [plainLines([...(after ? [after] : []), ...rest], '> ')] : [])].join('\n')
    }
    case 'rule':
      return '────────'
    case 'table':
      return alignedTable(block)
  }
}

/**
 * HTML と一緒に入れるプレーンテキスト（HTML を読まない貼り先用）: 書式の記号を外した文。リンクは `text (url)`、
 * リストは `•`（入れ子は字下げ）、コード・表（桁揃え）は中身だけ、引用・囲みは `> `。
 */
export const toReplySlackPlain = (source: string): string => parse(source, NO_HIGHLIGHT).map(plainBlock).join('\n\n')

// ---- まとめ ----

const CONVERT: Record<ReplyFormat, (source: string) => string> = {
  markdown: toReplyMarkdown,
  github: toReplyGitHub,
  slack: toReplySlack,
  notion: toReplyNotion,
}

/** 1 つの文を形式に合わせて書き直す。 */
export const convertText = (format: ReplyFormat, source: string): string => CONVERT[format](source)

/** 返事のテキストブロックをそれぞれ書き直してつなぐ（ブロックごとに書き直すので、閉じ忘れたコードが次へ漏れない）。 */
const joinReply = (texts: readonly string[], convert: (source: string) => string, separator: string): string =>
  texts
    .map(t => convert(t.replace(/^\s*\n|\s+$/g, '')))
    .filter(t => t.trim() !== '')
    .join(separator)

/** 返事のテキストブロックを形式ごとに書き直し、空行 1 つでつなぐ。 */
export const convertReply = (format: ReplyFormat, texts: readonly string[]): string => joinReply(texts, CONVERT[format], '\n\n')

/** Slack 用の書式付きテキスト（HTML とプレーンテキスト）。 */
export const convertReplySlackRich = (texts: readonly string[]): { html: string; plain: string } => ({
  html: joinReply(texts, toReplySlackHtml, SLACK_BLOCK_GAP),
  plain: joinReply(texts, toReplySlackPlain, '\n\n'),
})
