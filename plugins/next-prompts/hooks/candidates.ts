// 候補づくりのうち `$` に触れない部分: 会話の切り詰め、モデルへの依頼文、返事の読み取り、ラベルの幅。

/** `$.session.messages()` の 1 行のうち、ここで読むところだけ。 */
export type Message = {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly toolUses?: readonly { readonly tool: string }[]
  readonly toolResults?: readonly unknown[]
}

/** モデルに渡す会話の上限（文字数）。直近から遡ってここまで。 */
export const TRANSCRIPT_BUDGET = 24_000

/** 1 発言あたりの上限。ユーザーは頭を、Claude は終わり（次の一手の問いかけがある）を多めに残す。 */
const USER_HEAD = 1_200
const USER_TAIL = 600
const ASSISTANT_HEAD = 600
const ASSISTANT_TAIL = 2_000

/** 中身ごと落とすタグ（エンジンが会話に差し込む注記やコマンドの出力）。 */
const DROPPED_TAGS = ['system-reminder', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat']

/**
 * 発言の文から、エンジンが差し込んだ注記を落とし、残りのタグ記号を外して空白を均す。
 */
export function cleanText(text: string): string {
  let out = text

  for (const tag of DROPPED_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
  }

  return out
    .replace(/<\/?[a-z][a-z0-9-]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 長い文を頭と終わりだけ残して縮める。 */
export function clip(text: string, head: number, tail: number): string {
  const chars = Array.from(text)

  if (chars.length <= head + tail) return text

  return `${chars.slice(0, head).join('')}\n…（${chars.length - head - tail} 文字略）…\n${chars.slice(chars.length - tail).join('')}`
}

/** ツール名を回数つきで 1 行にまとめる（`Read×3, Edit`）。入出力の中身は出さない。 */
function toolsLine(tools: readonly string[]): string {
  const counts = new Map<string, number>()

  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)

  return [...counts].map(([tool, n]) => (n > 1 ? `${tool}×${n}` : tool)).join(', ')
}

/** 1 つの発言のまとまり（続けて来た同じ役の発言をまとめたもの）。 */
type Entry = { role: 'user' | 'assistant'; texts: string[]; tools: string[] }

/**
 * 会話を、モデルに渡す文に組む。ツールの結果だけのユーザー行は落とし、続けて来た Claude の行は
 * 1 つにまとめる（ツール名だけ残す）。直近から遡って `budget` 文字に収まるまで入れる。
 */
export function transcriptOf(messages: readonly Message[], budget = TRANSCRIPT_BUDGET): string {
  const entries: Entry[] = []

  for (const message of messages) {
    const text = cleanText(message.text ?? '')
    const tools = (message.toolUses ?? []).map(use => String(use.tool))

    // ツールの結果を返すだけの行（と、注記を落として空になった行）は会話に数えない。
    if (message.role === 'user' && text === '') continue
    if (message.role === 'assistant' && text === '' && tools.length === 0) continue

    const last = entries[entries.length - 1]

    if (last !== undefined && last.role === message.role) {
      if (text !== '') last.texts.push(text)
      last.tools.push(...tools)
    } else {
      entries.push({ role: message.role, texts: text === '' ? [] : [text], tools })
    }
  }

  const blocks: string[] = []
  let total = 0

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as Entry
    const body = entry.texts.join('\n\n')
    const block =
      entry.role === 'user'
        ? `[ユーザー]\n${clip(body, USER_HEAD, USER_TAIL)}`
        : `[Claude]\n${clip(body, ASSISTANT_HEAD, ASSISTANT_TAIL)}${entry.tools.length > 0 ? `\n（使ったツール: ${toolsLine(entry.tools)}）` : ''}`.replace('[Claude]\n\n', '[Claude]\n')
    const size = block.length + 2

    if (total + size > budget) {
      // いちばん新しい 1 つも入らないときは、終わりのほうを残して入れる。
      if (blocks.length === 0) blocks.push(block.slice(block.length - budget))
      break
    }

    blocks.push(block)
    total += size
  }

  return blocks.reverse().join('\n\n')
}

/** 送信済みの直前の依頼（いちばん新しいユーザーの発言）。 */
export function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Message

    if (message.role !== 'user') continue

    const text = cleanText(message.text ?? '')

    if (text !== '') return text
  }

  return ''
}

/** 候補を作らせるときの system。 */
export function systemOf(count: number): string {
  return [
    'あなたは Claude Code（コーディング用の AI エージェント）の入力補完を担当する。',
    'ユーザーと Claude の会話を読み、ユーザーが次に Claude へ送りそうな依頼文を予測する。',
    '',
    '規則:',
    `- ちょうど ${count} 個を、JSON の文字列配列だけで出力する。前置き・説明・コードフェンスは書かない`,
    '- ユーザーの口調に合わせる。日本語の会話なら日本語で、短い依頼文にする（例: 「テストも書いて」「この方針で進めて」「差分を見せて」）',
    '- 1 つ 40 文字以内',
    '- 直前のユーザーの依頼と同じものは出さない。互いに違う方向の候補にする（先へ進める・確かめる・直す・別の観点 など）',
    '- Claude が最後に質問や選択肢を出していれば、それへの答えを候補に入れる',
  ].join('\n')
}

/** 候補を作らせるときの依頼文。 */
export function promptOf(transcript: string, last: string, count: number): string {
  return [
    '<conversation>',
    transcript,
    '</conversation>',
    '',
    `直前のユーザーの依頼: ${last === '' ? '（なし）' : `「${clip(last, 200, 0)}」`}`,
    '',
    `ユーザーが次に送りそうな依頼を ${count} 個、JSON の文字列配列で出力してください。`,
  ].join('\n')
}

/** 1 つの候補を均す（改行・連続する空白・囲みのかぎ括弧を外す）。 */
export function normalize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const quoted = /^「(.*)」$/.exec(flat)

  return (quoted?.[1] ?? flat).trim()
}

/** 重なりを見るための鍵（末尾の句読点と大文字小文字の違いは同じとみなす）。 */
function keyOf(text: string): string {
  return normalize(text).replace(/[。．.!！?？、,\s]+$/u, '').toLowerCase()
}

/** 1 つの候補の長さの上限（これを超えるものは壊れた出力とみなして捨てる）。 */
const MAX_CANDIDATE_CHARS = 200

/**
 * 候補を並べ直す: 文字列だけ、均して、空と長すぎるものを捨て、重なりと `exclude` を除き、`count` 個まで。
 */
export function uniqueCandidates(items: readonly unknown[], count: number, exclude: readonly string[] = []): string[] {
  const seen = new Set(exclude.map(keyOf).filter(key => key !== ''))
  const out: string[] = []

  for (const item of items) {
    if (out.length >= count) break
    if (typeof item !== 'string') continue

    const text = normalize(item)
    const key = keyOf(text)

    if (key === '' || Array.from(text).length > MAX_CANDIDATE_CHARS || seen.has(key)) continue

    seen.add(key)
    out.push(text)
  }

  return out
}

/**
 * モデルの返事から候補を取り出す。前置きやコードフェンスがあっても最初の `[` から最後の `]` を読む。
 * 配列として読めなければ空（壊れた出力は捨てる）。
 */
export function parseCandidates(reply: string, count: number, exclude: readonly string[] = []): string[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')

  if (start < 0 || end <= start) return []

  let parsed: unknown

  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }

  return Array.isArray(parsed) ? uniqueCandidates(parsed, count, exclude) : []
}

/** 標準の提案を先頭に足して、重なりと直前の依頼を除く。 */
export function mergeCandidates(suggestion: string | null, generated: readonly string[], count: number, last: string): string[] {
  return uniqueCandidates(suggestion === null ? generated : [suggestion, ...generated], count, [last])
}

/** 端末で 2 セル使う文字か（CJK・全角・絵文字のおおまかな範囲）。 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** 文字列が端末で占めるセル数。 */
export function cellWidth(text: string): number {
  let width = 0

  for (const char of text) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1

  return width
}

/** `maxCells` に収まるよう末尾を `…` で切る。 */
export function truncateLabel(text: string, maxCells: number): string {
  if (cellWidth(text) <= maxCells) return text

  let out = ''
  let width = 0

  for (const char of text) {
    const w = isWide(char.codePointAt(0) ?? 0) ? 2 : 1

    if (width + w > maxCells - 1) break

    out += char
    width += w
  }

  return `${out}…`
}

/** 帯の先頭に置く見出し。 */
export const HEADING = '次の一手:'

/** ボタンの飾り（`[ ` と ` ]`）に見込むセル数。 */
const BUTTON_CHROME = 4

/** 並べる要素どうしの隙間。 */
export const GAP = 1

/** ラベルの幅の上限（帯の幅から 2 列ぶんを割り出す）。 */
export function labelLimitOf(columns: number): number {
  const half = Math.floor((columns - cellWidth(HEADING) - GAP) / 2) - BUTTON_CHROME - GAP

  return Math.max(10, Math.min(48, half))
}

/**
 * 帯に並べるラベルを決める。見出しのあとに順に詰め、`maxLines` 行に収まらない候補は出さない
 * （flexWrap が折り返すのと同じ詰め方）。返すのは出す候補の元の位置とラベル。
 */
export function layoutLabels(candidates: readonly string[], columns: number, maxLines = 2): { index: number; label: string }[] {
  const limit = labelLimitOf(columns)
  const out: { index: number; label: string }[] = []
  let line = 1
  let used = cellWidth(HEADING)

  for (const [index, text] of candidates.entries()) {
    const label = truncateLabel(text, limit)
    const width = cellWidth(label) + BUTTON_CHROME

    if (used + GAP + width > columns) {
      line += 1
      used = 0

      if (line > maxLines) break
    }

    used += (used === 0 ? 0 : GAP) + width
    out.push({ index, label })
  }

  return out
}
