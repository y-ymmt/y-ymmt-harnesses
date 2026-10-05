// prompt-trail: prompt-rail（https://github.com/oikon48/prompt-rail、MIT、作者 oikon48）の
// hooks/index.tsx を元にした改変版。本家のコメントは英語のまま残し、足した・変えた所に日本語のコメントを付けている。
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from './band'
import { EDITING_TOOLS, KIND_COLORS, KIND_WORDS, MARK, REJECTED, STRIP, USAGE, commandRowText, helpText, holds, isCommandText, isSlashCommand, kindOf, slashName, type Kind } from './trail'

const PLUGIN = 'prompt-trail'
const PANE = 'prompt-trail'
// Rows the person typed (terminal composer, desktop/remote bridge, SDK host).
const PROMPT_KINDS = new Set(['composer', 'bridge', 'sdk'])
// Columns the docked rail asks for: a tick and a little air.
const RAIL_COLUMNS = 4
// Below this many body columns the vertical rail has no room to reveal the
// prompt beside a tick, so the band above the prompt shows it instead.
const INLINE_REVEAL_MIN_COLUMNS = 12
// Cells a hover card keeps for the prompt's text beside the turn's details,
// and the desktop's label of the prompt being read beside the bars.
const MIN_CARD_TEXT = 12
// Cells the desktop's bars keep however narrow the band: one bar and its marks.
const MIN_DESKTOP_BARS = 3
// The mode is the plugin's `mode` setting (userConfig), a row in /config. An
// earlier version kept it in the store under this key, shared by every session.
const LEGACY_MODE_KEY = 'mode'
// `session-mode:<session id>` -> a mode the setting could not keep (a session
// with no /config row for plugin fields), so a module reloaded mid-session
// starts in it again. Keyed by session, so a later session starts clean.
const SESSION_MODE_KEY_PREFIX = 'session-mode:'
const MODE_SETTING = 'prompt-trail.mode'
// `transcript:<session id>` -> { path, at }, so a hot-reloaded module (whose
// session.start carries no path) can rebuild its list. One key per session, so
// sessions starting together never rewrite each other's; the newest few stay.
const TRANSCRIPT_KEY_PREFIX = 'transcript:'
const KEPT_TRANSCRIPTS = 20
// The id a prompt row is drawn under before its message is stored; the stored
// row follows under its uuid.
const PROVISIONAL_ID = 'placeholder'
// User rows the engine writes around its own output (slash commands, bash
// mode, reminders, subagent hand-backs and messages from other sessions), which are not prompts.
const WRAPPER = /^<(command-|local-command-|bash-|system-reminder|task-notification|user-prompt-submit-hook|agent-message|cross-session-message)/
// The viewer's state the engine puts ahead of a prompt sent while an artifact
// is open; the typed text follows it. No row field tells it from typed text,
// so only the engine's layout matches: the artifact id, a JSON line starting
// with "context", and the closing tag on a line of its own.
const VIEW_CONTEXT = /^\s*<artifact-view-context artifact="[^"]*">\n\{"context":[\s\S]*?\n<\/artifact-view-context>/
// The notice the engine stores as a user row when the person interrupts a turn.
const INTERRUPTED = /^\[Request interrupted by user/
// A message uuid, as the transcript stores it (see rowKey).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The rail is drawn again this many ms after the last onScreen report, and no
// later than SETTLE_MAX_MS after the first (see redrawRailSettled). Measured
// on the terminal: a replayed row is corrected within 13 ms, a layout settles
// within 18 ms.
const SETTLE_MS = 40
const SETTLE_MAX_MS = 120
// A row added at most this many ms before a prompt's notification may be that
// prompt's own: the engine draws a queued prompt's first row as it notifies.
const LATELY_MS = 250
// Cells kept left of the horizontal rail: off the window's edge, a pointer
// leaving the first bar crosses a cell and the surface sees the hover end.
const RAIL_INSET = 2
// The engine's refusal when no row is drawn under an id, as for a slash
// command's own row, which the transcript file holds but the surface skips.
// Other refusals (a race with another move) pass, so they leave the tick be.
const NOT_DRAWN = /nothing drawn/
// prompt-trail: 画面に描かれた `/名前` が一覧に無いときに一覧を取り直す間隔の下限（ms）。
const UNKNOWN_REFRESH_MS = 1500
// The engine's refusal where no transcript viewport takes a plugin's scroll,
// as in the desktop app; said once, in words of the rail's own.
const UNSCROLLABLE = /not scrollable/
const UNSCROLLABLE_TOAST = 'この画面では飛べません（Mod から会話をスクロールできない表示です）'
// A count the rail's sites (the pane and the band) read while drawing, so
// bumping it draws them again, and them alone. `$.ui.invalidate('ui.render')`
// also draws every transcript row this module hooks, and rows drawn again
// while the person scrolls just after a jump move the viewport a turn away.
const MOVED = { plugin: 'prompt-trail', key: 'moved' } as const
// How long the band's text line shows the card of the bar the focus ring is
// on after the ring last moved: no event says the ring left the band.
const RING_CARD_MS = 4000
// 棒をクリックした後、そのカード（[ 入力欄へ ] [ コピー ] つき）を文字の行に残す時間。
// ホバーのカードは指が棒を離れると消えるので、ボタンまで指を動かせないときの逃げ道。
const PICK_CARD_MS = 8000
// 打ちかけの文があるときに [ 入力欄へ ] の 2 回目を待つ時間（next-prompts と同じ）。
const CONFIRM_MS = 5000
// カードとペインの行に置くボタン。端末のボタンは `[ label ]` で、ラベルの両脇に 2 マスずつ取る。
const FILL_LABEL = '入力欄へ'
const COPY_LABEL = 'コピー'
// カードの頭に置くボタン 2 つとその後ろの空白の幅: `[ 入力欄へ ]` 12 + 空白 1 + `[ コピー ]` 10 + 空白 1。
const ACTIONS_CELLS = 24
// 帯のカードでボタンの横に残す文字の幅の下限。これより狭い帯ではカードにボタンを置かない。
// 右寄りの棒でも、ボタンを左へずらしてこれだけの文字を残す。
const CARD_TEXT_WITH_ACTIONS = 30
// 帯のカードで、ホバーした棒の真上に [ 入力欄へ ] のラベルの真ん中が来るよう、ボタンを棒の桁からこれだけ左へずらす。
const ACTIONS_LEAD_BACK = 5
// 帯の右半分の棒では、カードを左へ伸ばす: `本文… · 補足 #94 [ 入力欄へ ] [ コピー ]`。[ コピー ] の右端が棒の真上で終わる。
// 末尾の空白を持たないボタン 2 つの幅: 12 + 1 + 10。
const ACTIONS_CELLS_LEFT = 23
// これより狭いペインでは [ 入力欄へ ] [ コピー ] の行を出さない（/prompt-trail fill・copy で使う）。
// 行の頭の印・字下げ 3 マスと、ボタン 2 つ・間の空白 23 マス。
const PANE_ACTIONS_MIN_COLUMNS = 26
// Commands that step through the prompts, each with the way it steps.
const STEP_COMMANDS = [
  ['prompt-trail-next', 'next'],
  ['prompt-trail-prev', 'previous'],
] as const

// vertical: ticks in a docked pane; horizontal: ticks in a row above the
// prompt; off: no rail at all. One setting, so /config keeps a single row.
type Mode = 'off' | 'vertical' | 'horizontal'
const isMode = (value: unknown): value is Mode => value === 'off' || value === 'vertical' || value === 'horizontal'

// prompt-trail: command は、スラッシュコマンドを打った行（text は打った文 `/code-review --comment`）。
// モデルへの依頼になってターンが走るものだけが一覧に入る。
type Entry = { id: string; text: string; command?: true }

// The key rows are matched by. A message the engine splits into several rows
// is drawn under ids derived from its stored uuid, the first four groups kept
// and the last replaced by the row's index, so a uuid is matched by those
// groups; any other id (a tool_use id, the provisional one) as it is.
export const rowKey = (id: string) => (UUID.test(id) ? id.slice(0, 24) : id)

// prompt-trail: 記録のコマンドの行（ターンが走るもの）に、画面に描かれた `❯ /code-review …` の行を、
// 打った文と順番（同じ文の n 番目どうし）で結び付ける。`rows` は描かれた id -> 打った文（描かれた順）。
// 返すのは、記録の行の id -> 結び付いた描かれた id。
export const bindCommandRows = (entries: Entry[], rows: Map<string, string>): Map<string, string> => {
  const byText = new Map<string, string[]>()
  for (const [id, text] of rows) byText.set(text, [...(byText.get(text) ?? []), id])
  const counts = new Map<string, number>()
  const bound = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.command) continue
    const n = counts.get(entry.text) ?? 0
    counts.set(entry.text, n + 1)
    const id = byText.get(entry.text)?.[n]
    if (id !== undefined) bound.set(entry.id, id)
  }
  return bound
}

// prompt-trail: 飛び先の候補（前から試す）。ふつうのプロンプトは描かれた行。コマンドの行は、結び付いた描かれた
// `❯ /code-review …` の行、なければそのターンの最初の返事の行（描かれた id があればそれ）、どちらも無ければ
// 記録の行の id（描かれていないので断られ、点線になる）。
export const jumpTargets = (entry: Entry, drawn: Map<string, string>, replies: Map<string, string>, drawnReplies: Map<string, string>): string[] => {
  if (!entry.command) return [drawnRow(drawn, entry.id)]
  const targets: string[] = []
  const bound = drawn.get(rowKey(entry.id))
  if (bound !== undefined) targets.push(bound)
  const reply = replies.get(rowKey(entry.id))
  if (reply !== undefined) targets.push(drawnReplies.get(rowKey(reply)) ?? reply)
  return targets.length > 0 ? targets : [entry.id]
}

// The id a prompt's row was last drawn under, which a jump scrolls to, from a
// map of row key -> drawn id; its own id while it has not been drawn.
export const drawnRow = (drawn: Map<string, string>, id: string) => drawn.get(rowKey(id)) ?? id

// Terminal cells a character takes: two for East Asian wide and emoji ranges.
const cells = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return isWide ? 2 : 1
}

const cellWidth = (text: string) => [...text].reduce((sum, char) => sum + cells(char), 0)

// `text` padded with spaces to `width` cells, so a card painted over the
// default line hides it whole.
const padTo = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)))

// The prompt on one line, cut to `width` terminal cells with an ellipsis.
const oneLine = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.reduce((sum, char) => sum + cells(char), 0) <= width) return flat
  let out = ''
  let used = 0
  for (const char of chars) {
    if (used + cells(char) > width - 1) break
    out += char
    used += cells(char)
  }
  return `${out}…`
}

// A stacked rail reads rows apart; a row of ticks needs upright bars to. A
// dotted one marks a prompt the transcript does not draw, so a jump fails.
export const tick = (isCurrent: boolean, isUnreachable = false) => (isCurrent ? '━' : isUnreachable ? '┄' : '─')
export const bar = (isCurrent: boolean, isUnreachable = false) => (isCurrent ? '┃' : isUnreachable ? '┆' : '│')

// Record what a jump to `id` answered: a landing makes it reachable, a refusal
// for want of a drawn row unreachable, any other refusal says nothing. True
// when the set changed.
export const noteScroll = (unreachable: Set<string>, id: string, deny: string | undefined) => {
  const was = unreachable.has(id)
  if (deny === undefined) unreachable.delete(id)
  else if (NOT_DRAWN.test(deny)) unreachable.add(id)
  return unreachable.has(id) !== was
}

// What a refused jump says: the engine's refusal as it words it, or, where
// the view cannot scroll the transcript at all, words of the rail's own the
// first time; undefined once those were said.
export const jumpNotice = (deny: string, isUnscrollableSaid: boolean) =>
  UNSCROLLABLE.test(deny) ? (isUnscrollableSaid ? undefined : UNSCROLLABLE_TOAST) : deny

// The prompt one step from `current` in direction `dir`, passing over those
// `isSkipped` names; from an unknown place (-1), the first or the last. -1
// when there is none that way.
export const stepFrom = (current: number, count: number, dir: 1 | -1, isSkipped: (i: number) => boolean) => {
  let i = current >= 0 ? current + dir : dir > 0 ? 0 : count - 1
  for (; i >= 0 && i < count; i += dir) if (!isSkipped(i)) return i
  return -1
}

// The prompt `/prompt-trail <asked>` names among `texts`: `n` or `#n` by its
// number, `first`, `last`, or with `find <words>` the newest whose text holds
// them. -1 when none does; undefined when `asked` names none.
// prompt-trail: find は全角/半角・大文字/小文字・ひらがな/カタカナの揺れを区別しない（trail.ts の fold）。
export const pickPrompt = (asked: string, texts: string[]) => {
  const number = /^#?(\d+)$/.exec(asked)
  if (number) {
    const i = Number(number[1]) - 1
    return i < texts.length ? i : -1
  }
  if (asked === 'first') return texts.length > 0 ? 0 : -1
  if (asked === 'last') return texts.length - 1
  // 「find」自体も全角（ｆｉｎｄ）で打たれうるので、NFKC にしてから見る。
  const words = /^find[\s\u3000]+(.+)$/is.exec(asked.normalize('NFKC'))?.[1]
  if (words === undefined) return undefined
  for (let i = texts.length - 1; i >= 0; i--) if (holds(texts[i] ?? '', words)) return i
  return -1
}

// What the transcript records of the turn a prompt started: how long it took
// (`durationMs` as the engine reported it, else `spanMs` from the prompt to
// the latest reply), how many tools it called, the paths of the files it
// edited, and, unless it simply answered, how it went.
// prompt-trail: 失敗したツールの数（failed）と拒否されたツールの数（rejected）を足した（無ければ 0）。
// files から、結果が失敗・拒否だった編集を除く（本家は呼んだだけで数えていた）。
export type Turn = { durationMs?: number; spanMs?: number; tools: number; files: string[]; failed?: number; rejected?: number; outcome?: Outcome }
// A turn still running, stopped by the person, or ended by an API error.
type Outcome = 'running' | 'interrupted' | 'error'
const OUTCOME_WORDS: Record<Outcome, string> = { running: '実行中', interrupted: '中断', error: 'API エラー' }
const emptyTurn = (): Turn => ({ tools: 0, files: [] })

// A duration as the rail shows it: `7秒`, `1分23秒`, `1時間2分`.
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${Math.floor(seconds / 3600)}時間${Math.floor((seconds % 3600) / 60)}分`
}

// The files a turn line names before it counts the rest.
const NAMED_FILES = 3

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean)

// Each path by its file name, or by its folder and name where two share one.
const fileNames = (paths: string[]) => {
  const base = (path: string) => segments(path).at(-1) ?? path
  return paths.map(path =>
    paths.some(other => other !== path && base(other) === base(path)) ? segments(path).slice(-2).join('/') : base(path),
  )
}

// A turn on one line: `1分23秒 · ツール 4 · 失敗 1 · 編集 2（app.ts, README.md）`, each part
// left out when the transcript has nothing for it; empty when it has nothing.
// Given `maxCells`, it names fewer files (down to a count) to fit in them.
// prompt-trail: 言葉を日本語にし、失敗・拒否の数と編集したファイルの数を足した。
export const turnLine = (turn: Turn | undefined, maxCells = Infinity) => {
  if (!turn) return ''
  const parts: string[] = []
  const ms = turn.durationMs ?? turn.spanMs
  if (ms !== undefined) parts.push(duration(ms))
  if (turn.outcome) parts.push(OUTCOME_WORDS[turn.outcome])
  if (turn.tools > 0) parts.push(`ツール ${turn.tools}`)
  if (turn.rejected) parts.push(`拒否 ${turn.rejected}`)
  if (turn.failed) parts.push(`失敗 ${turn.failed}`)
  const names = fileNames(turn.files)
  const withFiles = (named: number) => {
    if (names.length === 0) return parts.join(' · ')
    const rest = names.length - named
    const files =
      named > 0
        ? `編集 ${names.length}（${names.slice(0, named).join(', ')}${rest > 0 ? ` +${rest}` : ''}）`
        : `編集 ${names.length}`
    return [...parts, files].join(' · ')
  }
  for (let named = Math.min(NAMED_FILES, names.length); named > 0; named--) {
    const line = withFiles(named)
    if (cellWidth(line) <= maxCells) return line
  }
  return withFiles(0)
}

type TranscriptIndex = {
  prompts: Entry[]
  // The turn each prompt started, in the same order.
  turns: Turn[]
  // Reply row uuid or tool_use id -> index into prompts of the prompt it answers.
  owners: [string, number][]
  // Every row uuid the file holds, live branch or not.
  known: Set<string>
}

// prompt-trail: プロンプトの row key -> そのターンの最初の返事の行の id。コマンドの行が画面に描かれていないとき、そこへ飛ぶ。
export const firstReplies = (index: TranscriptIndex): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [id, i] of index.owners) {
    const prompt = index.prompts[i]
    if (prompt && !out.has(rowKey(prompt.id))) out.set(rowKey(prompt.id), id)
  }
  return out
}

// The uuids on the live branch: the chain of parents from the last row. A
// /rewind leaves the abandoned branch in the file; a /compact boundary starts
// a new chain whose logicalParentUuid links back to the rows before it.
const liveBranch = (rows: any[]) => {
  const byId = new Map<string, any>()
  for (const row of rows) byId.set(row.uuid, row)
  const live = new Set<string>()
  let row = [...rows].reverse().find(candidate => !candidate.isSidechain)
  while (row && !live.has(row.uuid)) {
    live.add(row.uuid)
    const parent = row.parentUuid ?? row.logicalParentUuid
    row = typeof parent === 'string' ? byId.get(parent) : undefined
  }
  return live
}

// What the index reads of a transcript row, and nothing else: a long
// session's rows are kept between reads, and most of their bytes are tool
// results and replies the rail never shows. Undefined for a line that is not
// a row (a torn last line while the engine appends, or no uuid).
const parseRow = (line: string): any => {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof row?.uuid !== 'string') return undefined
  const content = row.message?.content
  const blocks = Array.isArray(content)
    ? content.flatMap((block: any): Record<string, unknown>[] => {
        if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
        // prompt-trail: 結果が失敗か・拒否か、どの呼び出しの結果かを残す（本文は捨てる）。
        if (block?.type === 'tool_result') {
          return [{ type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error === true, isRejected: block.is_error === true && REJECTED.test(resultText(block.content)) }]
        }
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          // prompt-trail: NotebookEdit は notebook_path にパスがある。
          const field = EDITING_TOOLS[block.name] ?? 'file_path'
          const path = block.input?.[field]
          return [{ type: 'tool_use', id: block.id, name: block.name, input: typeof path === 'string' ? { file_path: path } : {} }]
        }
        return []
      })
    : content
  return {
    uuid: row.uuid,
    parentUuid: row.parentUuid,
    logicalParentUuid: row.logicalParentUuid,
    isSidechain: row.isSidechain,
    type: row.type,
    subtype: row.subtype,
    durationMs: row.durationMs,
    isApiErrorMessage: row.isApiErrorMessage,
    isMeta: row.isMeta,
    isCompactSummary: row.isCompactSummary,
    timestamp: row.timestamp,
    message: row.message && { role: row.message.role, content: typeof content === 'string' ? content : blocks },
    attachment: row.attachment?.type === 'queued_command' ? { type: row.attachment.type, prompt: row.attachment.prompt } : undefined,
  }
}

// prompt-trail: ツールの結果の本文（文字列か、text ブロックの並び）の頭。拒否の文言を見分けるのに使う。
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content.slice(0, 400)
  if (!Array.isArray(content)) return ''
  const first = content.find((block: any) => block?.type === 'text' && typeof block.text === 'string')
  return typeof first?.text === 'string' ? first.text.slice(0, 400) : ''
}

// The rows of a transcript JSONL's text, in order.
const parseRows = (jsonl: string) => jsonl.split('\n').flatMap(line => (line.trim() ? (parseRow(line) ?? []) : []))

// prompt-trail: 記録ファイルの行の本文（文字列か、text ブロックをつないだもの）。
const rowText = (row: any): string => {
  const content = row?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

// prompt-trail: `rows[from]`（コマンドの行）が、モデルへの依頼になってターンが走るものか。記録の印だけで決める:
// 直後の会話の行が、コマンドの展開（isMeta の user の行。スキル・プロンプト型のカスタムコマンド）か assistant の返事なら走る。
// 組み込みの `/compact` `/plugin` などは直後が `<local-command-stdout>` の行（isMeta でない user の行）で、
// Mod が登録したコマンドは system の local_command の行なので、走らない。
// 一覧（`$.command.list()`）は見ない: あとでコマンドが増減しても、過去の行の判定が変わらない。
const startsTurn = (rows: any[], from: number): boolean => {
  for (let j = from + 1; j < rows.length; j++) {
    const row = rows[j]
    if (row.isSidechain) continue
    if (row.type === 'assistant') return true
    if (row.type === 'system') {
      if (row.subtype === 'local_command') return false
      continue
    }
    if (row.type !== 'user') continue
    if (!row.isMeta) return false
    // 警告・注意書きの行は展開ではない。その先を見る。
    if (/^<(local-command|system-reminder)/.test(rowText(row).trimStart())) continue
    return true
  }
  return false
}

// The person's prompts on the live branch of a transcript's rows, in order,
// keyed by message uuid, and the prompt each reply row and tool call answers
// (a tool row is drawn under its tool_use id). Tool results, meta rows,
// sidechains and the engine's wrapper rows are not prompts.
export const indexRows = (rows: any[]): TranscriptIndex => {
  const live = liveBranch(rows)
  const prompts: Entry[] = []
  const owners: [string, number][] = []
  const turns: Turn[] = []
  // When each turn started and when its latest reply was written.
  const times: { start: number; last: number }[] = []
  // The prompt that started the turn being read: a prompt delivered into a
  // turn is listed, but the turn's details stay with the one that started it.
  let started = -1
  // prompt-trail: 編集のツール呼び出し（id → パスとターン）。結果が失敗・拒否なら、同じターンで
  // 同じパスへの他の編集が残っていない限り、そのパスを編集したファイルから外す。
  const edits = new Map<string, { path: string; turn: Turn }>()
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.isSidechain || !live.has(row.uuid)) continue
    const turn = turns[started]
    if (row.type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      if (turn) turn.durationMs = (turn.durationMs ?? 0) + row.durationMs
      continue
    }
    if (row.type === 'assistant') {
      if (prompts.length === 0 || !turn) continue
      // A reply places the reader under the latest prompt, delivered or not.
      const owner = prompts.length - 1
      owners.push([row.uuid, owner])
      if (row.isApiErrorMessage === true) turn.outcome = 'error'
      const at = Date.parse(row.timestamp)
      if (Number.isFinite(at)) times[started]!.last = at
      const blocks = Array.isArray(row.message?.content) ? row.message.content : []
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        owners.push([block.id, owner])
        turn.tools++
        const path = block.input?.file_path
        if (block.name in EDITING_TOOLS && typeof path === 'string') {
          edits.set(block.id, { path, turn })
          if (!turn.files.includes(path)) turn.files.push(path)
        }
      }
      continue
    }
    // A prompt typed while a turn ran and delivered into it is stored as a
    // queued_command attachment, never as a user row of its own.
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
      const prompt = row.attachment.prompt
      const text = typeof prompt === 'string' ? prompt.replace(VIEW_CONTEXT, '').trim() : ''
      if (!text || WRAPPER.test(text) || isSlashCommand(text)) continue
      prompts.push({ id: row.uuid, text })
      turns.push(emptyTurn())
      times.push({ start: NaN, last: NaN })
      continue
    }
    if (row.type !== 'user' || row.isMeta || row.isCompactSummary || row.message?.role !== 'user') continue
    const content = row.message.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
    }
    text = text.replace(VIEW_CONTEXT, '').trim()
    // prompt-trail: コマンドの行（`<command-name>` の印）。ターンが走るものだけを、打った文で一覧に入れる。
    // 走らないもの（/compact・/plugin・/config など）は、これまで通り入れない。
    const command = typeof content === 'string' ? commandRowText(content) : undefined
    if (command !== undefined) {
      if (!startsTurn(rows, rowIndex)) continue
      prompts.push({ id: row.uuid, text: command, command: true })
      turns.push(emptyTurn())
      started = prompts.length - 1
      const at = Date.parse(row.timestamp)
      times.push({ start: at, last: at })
      continue
    }
    // prompt-trail: ツールの結果を、そのターンの失敗・拒否・編集に数える。中断の知らせが同じ行に乗ることがあるので、その前に。
    if (Array.isArray(content) && turn) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        if (block.isRejected) turn.rejected = (turn.rejected ?? 0) + 1
        else if (block.is_error) turn.failed = (turn.failed ?? 0) + 1
        const edit = typeof block.tool_use_id === 'string' ? edits.get(block.tool_use_id) : undefined
        if (!edit || !block.is_error) continue
        edits.delete(block.tool_use_id)
        const isKept = [...edits.values()].some(other => other.turn === edit.turn && other.path === edit.path)
        if (!isKept) edit.turn.files = edit.turn.files.filter(path => path !== edit.path)
      }
    }
    // An interruption notice ends its turn; one mid tool call rides with the
    // call's result, so it is read before tool results are passed over.
    if (INTERRUPTED.test(text)) {
      if (turn) turn.outcome = 'interrupted'
      continue
    }
    if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) continue
    // prompt-trail: コマンドの行は上の `<command-name>` の印で決めたので、WRAPPER の行だけを外す。
    // `/` で始まるだけの文（`/tmp のログを見て`）は、記録では印の無い ふつうのプロンプト。
    if (!text || WRAPPER.test(text)) continue
    prompts.push({ id: row.uuid, text })
    turns.push(emptyTurn())
    started = prompts.length - 1
    const at = Date.parse(row.timestamp)
    times.push({ start: at, last: at })
  }
  turns.forEach((turn, i) => {
    const time = times[i]
    if (time && Number.isFinite(time.start) && time.last > time.start) turn.spanMs = time.last - time.start
  })
  return { prompts, turns, owners, known: new Set(rows.map(row => row.uuid)) }
}

// The engine's cap on one $.fs.read; a larger transcript is streamed.
const READ_CAP = 4 * 1024 * 1024
const encoder = new TextEncoder()

// The transcript as last read: its size and modification time, the rows of
// its complete lines and the byte where they end, and where the last row
// starts, which a later read of a long session's file checks is still there.
// Whether a read is under way, and the path whose file could not be read,
// said once.
type Seen = {
  path: string
  size: number
  mtimeMs: number
  rows: any[]
  offset: number
  lastStart: number
  lastUuid: string | undefined
  isReading: boolean
  warned: string
}
const unseen = (): Seen => ({
  path: '',
  size: -1,
  mtimeMs: -1,
  rows: [],
  offset: 0,
  lastStart: 0,
  lastUuid: undefined,
  isReading: false,
  warned: '',
})

// Take the complete lines of `text`, which starts at byte `at` of the file,
// into `seen`, and return the rest: a line the engine is still writing, or
// the last of a file with no newline at its end.
const takeLines = (seen: Seen, text: string, at: number) => {
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    const row = line.trim() ? parseRow(line) : undefined
    if (row) {
      seen.rows.push(row)
      seen.lastStart = at
      seen.lastUuid = row.uuid
    }
    at += encoder.encode(line).length + 1
  }
  seen.offset = at
  return rest
}

// The index of the rows read, and of a last line with no newline yet when it
// parses whole (it is read again once it has one).
const indexSeen = (seen: Seen, rest: string) => {
  const last = rest.trim() ? parseRow(rest) : undefined
  return indexRows(last ? [...seen.rows, last] : seen.rows)
}

// Read the file on from the last row read, with tail, since $.fs.read takes
// no more than READ_CAP. That row comes first and must still be there, else
// the file was replaced: false then, and nothing is taken. Otherwise the rest
// after the last complete line.
async function streamRows($: EngineInterface, path: string, seen: Seen) {
  let expected = seen.lastUuid
  let at = expected === undefined ? seen.offset : seen.lastStart
  let carry = ''
  const child = $.process.spawn({ argv: ['tail', '-c', `+${at + 1}`, path] })
  for await (const piece of child) {
    if (piece.stream !== 'stdout') continue
    let text = carry + piece.text
    if (expected !== undefined) {
      const end = text.indexOf('\n')
      if (end < 0) {
        carry = text
        continue
      }
      const line = text.slice(0, end)
      if (parseRow(line)?.uuid !== expected) return false
      expected = undefined
      at += encoder.encode(line).length + 1
      text = text.slice(end + 1)
    }
    carry = takeLines(seen, text, at)
    at = seen.offset
  }
  const { code } = await child.result
  if (code !== 0) throw new Error(`tail exited with ${code}`)
  return carry
}

// Stream a transcript too large for $.fs.read, from its start when it was
// replaced; its index, or undefined when it could not be read, which is said
// once for the file.
async function readLarge($: EngineInterface, path: string, seen: Seen, size: number, mtimeMs: number) {
  try {
    let rest = await streamRows($, path, seen)
    if (rest === false) {
      Object.assign(seen, { rows: [], offset: 0, lastStart: 0, lastUuid: undefined })
      rest = await streamRows($, path, seen)
      if (rest === false) return undefined
    }
    Object.assign(seen, { path, size, mtimeMs })
    return indexSeen(seen, rest)
  } catch (err) {
    if (seen.warned !== path) {
      seen.warned = path
      const megabytes = Math.round(size / 1024 / 1024)
      $.ui.toast(`トランスクリプトが ${megabytes} MB あり、ここでは読めませんでした（${(err as Error).message}）。描かれたプロンプトだけを並べます`)
    }
    return undefined
  }
}

// The transcript's index, or undefined when it is as `seen` last read it (a
// long session's file is not parsed again for a turn that wrote nothing),
// before the file exists (a fresh session), or while another read is under
// way. Records what it read in `seen`. A file over READ_CAP is read on from
// where the last read ended; when that is more than READ_CAP, as on resuming a
// long session, it is read without holding the hook, and `whenLate` gets the
// index once it is done.
async function readTranscript($: EngineInterface, path: string, seen: Seen, whenLate: (index: TranscriptIndex) => void) {
  if (seen.isReading) return undefined
  try {
    const { size, mtimeMs } = await $.fs.stat(path)
    if (seen.path === path && seen.size === size && seen.mtimeMs === mtimeMs) return undefined
    if (seen.path !== path || size < seen.offset) Object.assign(seen, { ...unseen(), warned: seen.warned })
    if (size <= READ_CAP) {
      const text = await $.fs.read(path)
      Object.assign(seen, { rows: [], lastStart: 0, lastUuid: undefined })
      const rest = takeLines(seen, text, 0)
      Object.assign(seen, { path, size, mtimeMs })
      return indexSeen(seen, rest)
    }
    seen.isReading = true
    const reading = readLarge($, path, seen, size, mtimeMs).finally(() => {
      seen.isReading = false
    })
    if (size - seen.offset <= READ_CAP) return await reading
    void reading.then(index => index && whenLate(index))
    return undefined
  } catch {
    seen.isReading = false
    return undefined
  }
}

// Remember this session's transcript path under its own key, then drop all
// but the newest few sessions' keys.
async function rememberTranscript($: EngineInterface, sessionId: string, transcriptPath: string) {
  await $.store.set(`${TRANSCRIPT_KEY_PREFIX}${sessionId}`, { path: transcriptPath, at: Date.now() })
  const keys = (await $.store.keys()).filter(key => key.startsWith(TRANSCRIPT_KEY_PREFIX))
  if (keys.length <= KEPT_TRANSCRIPTS) return
  const dated = await Promise.all(
    keys.map(async key => {
      const value = (await $.store.get(key)) as { at?: unknown } | undefined
      return { key, at: typeof value?.at === 'number' ? value.at : 0 }
    }),
  )
  dated.sort((x, y) => y.at - x.at)
  await Promise.all(dated.slice(KEPT_TRANSCRIPTS).map(({ key }) => $.store.delete(key)))
}

// Open the pane where the mode draws the rail in it; close it elsewhere (off,
// or horizontal on the terminal, where the band carries the rail).
async function seatRail($: EngineInterface, mode: Mode, isTerminal: boolean) {
  if (mode === 'off' || (mode === 'horizontal' && isTerminal)) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: 'プロンプト', columns: RAIL_COLUMNS })
  }
}

// Write the mode setting, as a change in /config would; say so if refused.
// A session with no /config row for plugin fields (the desktop app's SDK
// sessions) throws instead of denying, and the mode then holds for this
// session only.
async function writeMode($: EngineInterface, mode: Mode) {
  try {
    const result = await $.config.set({ key: MODE_SETTING, value: mode })
    if (result.deny) $.ui.toast(`表示の形を保存できませんでした: ${result.deny}`)
  } catch (err) {
    await $.store.set(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`, mode)
    $.ui.toast(`このセッションだけ ${mode} にしました（保存できませんでした: ${(err as Error).message}）`)
  }
}

// Scroll the transcript to a prompt's row, drawn under `target`, from a
// dispatch that answers the person's own input (a press, a typed command): a
// transcript row moves only then. Records whether the prompt could be reached,
// and returns whether the transcript scrolled to it. Where the view cannot
// scroll at all, says so once a session (`notices.isUnscrollableSaid`).
async function jumpTo($: EngineInterface, id: string, target: string, unreachable: Set<string>, notices: { isUnscrollableSaid: boolean }) {
  try {
    const result = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
    if (result.deny) {
      const notice = jumpNotice(result.deny, notices.isUnscrollableSaid)
      if (notice !== undefined) $.ui.toast(notice)
      if (UNSCROLLABLE.test(result.deny)) notices.isUnscrollableSaid = true
    }
    if (noteScroll(unreachable, id, result.deny)) await redrawRail($)
    return !result.deny
  } catch (err) {
    $.ui.toast((err as Error).message)
    return false
  }
}

// prompt-trail: 飛び先の候補を前から試す。最後の 1 つ以外は「描かれていない」などで断られても黙って次へ進み、
// 最後の 1 つの答えだけを jumpTo と同じに扱う（断りの知らせ・飛べない印）。飛べた先を返す。
async function jumpFirst($: EngineInterface, id: string, targets: string[], unreachable: Set<string>, notices: { isUnscrollableSaid: boolean }) {
  for (const target of targets.slice(0, -1)) {
    try {
      const result = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
      if (!result.deny) {
        if (noteScroll(unreachable, id, undefined)) await redrawRail($)
        return target
      }
    } catch {
      // 次の候補へ。
    }
  }
  const last = targets.at(-1)
  return last !== undefined && (await jumpTo($, id, last, unreachable, notices)) ? last : undefined
}

// prompt-trail: コマンドの一覧を取り直し、`accept` に渡して、その結果（決め直した行）を流す。取れなければ undefined を渡す。
async function reloadCommands<Row>(
  $: EngineInterface,
  accept: (names: Set<string> | undefined) => { reported: boolean; cut: Row | undefined; changed: boolean }[],
  settle: Settle,
  confirm: (row: Row) => void,
  isStale: () => boolean,
) {
  let names: Set<string> | undefined
  try {
    names = new Set((await $.command.list()).map(command => command.name))
  } catch {
    names = undefined
  }
  flushRows($, accept(names), settle, confirm, isStale)
}

// prompt-trail: 描かれた行を扱った結果を流す: 並びが変わったなら描き直し、位置の報告があれば afterReport。
function flushRows<Row>(
  $: EngineInterface,
  outs: { reported: boolean; cut: Row | undefined; changed: boolean }[],
  settle: Settle,
  confirm: (row: Row) => void,
  isStale: () => boolean,
) {
  if (outs.some(out => out.changed)) redrawRailLater($)
  for (const out of outs) if (out.reported) afterReport($, settle, out.cut, confirm, isStale)
}

// Draw the rail's sites again, and them alone (see MOVED).
async function redrawRail($: EngineInterface) {
  const { value = 0 } = await $.state.get(MOVED)
  await $.state.set(MOVED, value + 1)
}

// The same from a render hook, which may not write state: once its dispatch ends.
function redrawRailLater($: EngineInterface) {
  $.clock.after(0, () => void redrawRail($))
}

// The timers of a redraw waiting for onScreen reports to settle.
type Settle = { quiet?: Timer; latest?: Timer }

// Draw the rail again once onScreen reports settle, if `isStale` then says the
// drawing no longer shows the prompt being read: SETTLE_MS after the last
// report, and no later than SETTLE_MAX_MS after the first, so reports that
// never pause (a scroll held down, a running tool row) still redraw it. A
// remounted row replays where it was last seen and a layout may settle over
// two frames; the surface corrects both within a frame or two.
function redrawRailSettled($: EngineInterface, settle: Settle, isStale: () => boolean) {
  const fire = () => {
    settle.quiet?.cancel()
    settle.latest?.cancel()
    settle.quiet = undefined
    settle.latest = undefined
    if (isStale()) void redrawRail($)
  }
  settle.quiet?.cancel()
  settle.quiet = $.clock.after(SETTLE_MS, fire)
  settle.latest ??= $.clock.after(SETTLE_MAX_MS, fire)
}

// After one onScreen report: a row that said it is cut at the viewport's top
// is confirmed once a replay would have been corrected (see SETTLE_MS), and
// the rail is drawn again once reports settle.
function afterReport<Row>($: EngineInterface, settle: Settle, cut: Row | undefined, confirm: (row: Row) => void, isStale: () => boolean) {
  if (cut !== undefined) $.clock.after(SETTLE_MS, () => confirm(cut))
  redrawRailSettled($, settle, isStale)
}

// prompt-trail: 過去のプロンプトの再利用（入力欄へ・コピー）。
// [ 入力欄へ ] の 2 回目を待っている間の印。打ちかけの文を上書きする前に確かめる（next-prompts の choose と同じ流儀）。
type FillHold = { armed: { index: number; until: number } | undefined }

// `entries[index]` の文を入力欄に入れる（送信はしない）。入力欄に打ちかけの文があれば、
// 同じボタンをもう一度押すまで（CONFIRM_MS 以内）置き換えない。
async function fillPrompt($: EngineInterface, entries: Entry[], index: number, hold: FillHold) {
  const entry = entries[index]
  if (!entry) return
  const draft = (await $.prompt.read()).text.trim()
  // 空か、このセッションのプロンプトのどれかを入れたままなら、そのまま置き換える。
  const isOwnDraft = draft !== '' && !entries.some(other => other.text === draft)
  if (isOwnDraft) {
    const now = await $.clock.now()
    if (hold.armed?.index !== index || now > hold.armed.until) {
      hold.armed = { index, until: now + CONFIRM_MS }
      $.ui.toast('入力欄に打ちかけの文があります。もう一度押すと置き換えます', { timeoutMs: CONFIRM_MS })
      return
    }
  }
  hold.armed = undefined
  const result = await $.prompt.fill({ text: entry.text, mode: 'replace' })
  if (!result.isFilled) {
    $.ui.toast(result.refusal === 'dialog' ? 'ダイアログが開いている間は入力欄に入れられません' : '入力欄に入れられませんでした')
  }
}

// `entries[index]` の文をクリップボードへ。押された表示面（surface）で写す。
async function copyPrompt($: EngineInterface, entries: Entry[], index: number, surface?: RenderSurface) {
  const entry = entries[index]
  if (!entry) return
  const result = await $.ui.copy(surface === undefined ? { text: entry.text } : { text: entry.text, surface })
  if (result.isCopied) $.ui.toast(`#${index + 1} をコピーしました`)
  else $.ui.toast(result.reason === 'no-surface' ? 'コピーできませんでした（クリップボードのある画面がありません）' : 'コピーできませんでした')
}

// The transcript path remembered for this session, if any.
async function rememberedTranscript($: EngineInterface) {
  const value = (await $.store.get(`${TRANSCRIPT_KEY_PREFIX}${await $.session.id()}`)) as { path?: unknown } | undefined
  return typeof value?.path === 'string' ? value.path : undefined
}

// prompt-trail: このセッションのトランスクリプトの場所。classic.SessionStart・classic.Stop が教えてくれるほか、
// 覚えた場所か、置き場所の決まりから探した場所。
type Place = { at: string | undefined }

// prompt-trail: トランスクリプトの場所。classic.* の hook は、管理された設定のある機械では組み込みのセキュリティの
// プラグインに飛ばされ（debug ログに `classic.SessionStart bypassed by ...`）、ユーザーのプラグインには届かない。
// そこでも記録を読めるよう、session.start とターンの始め・終わりでも、覚えた場所か置き場所の決まりから求めて覚える。
async function transcriptPathOf($: EngineInterface, place: Place) {
  if (place.at !== undefined) return place.at
  const remembered = await rememberedTranscript($)
  const path = remembered ?? (await foundTranscript($))
  if (path === undefined) return undefined
  place.at = path
  if (remembered === undefined) await rememberTranscript($, await $.session.id(), path)
  return path
}

// prompt-trail: 記録を読んで並びに混ぜ、変わったら描き直す（後から読み終えた分も）。
async function readAndMerge($: EngineInterface, seen: Seen, merge: (index: TranscriptIndex) => boolean, path: string) {
  const index = await readTranscript($, path, seen, index => {
    if (merge(index)) void redrawRail($)
  })
  if (index && merge(index)) await redrawRail($)
  return index
}

// prompt-trail: プロジェクトのフォルダ名。Claude Code はセッションを始めたフォルダのパスの英数字以外を `-` にした名前の
// フォルダ（設定フォルダの projects の下）に、セッション id を名前にしたトランスクリプトを置く。
export const projectFolderName = (root: string) => root.replace(/[^a-zA-Z0-9]/g, '-')

// prompt-trail: このセッションのトランスクリプトを探す。セッションの途中で入れた・有効にした Mod は
// classic.SessionStart を受け取れず、トランスクリプトの場所を覚えていない。そのままでは読めるまで描かれた行だけを
// 描かれた順（スクロールで上の行が後から描かれると逆順）に並べてしまうので、置き場所の決まりから探す。
// 見つからなければ undefined（次のターンの始め・終わりで探し直す。classic.Stop が届けば、その場所を使う）。
async function foundTranscript($: EngineInterface) {
  try {
    const id = await $.session.id()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
    if (config === undefined) return undefined
    const projects = `${config.replace(/[\\/]+$/, '')}/projects`
    const roots = [...new Set([await $.session.root(), await $.session.cwd()])]
    for (const root of roots) {
      const path = `${projects}/${projectFolderName(root)}/${id}.jsonl`
      if (await $.fs.exists(path)) return path
    }
    // 長いパスのフォルダ名は切られて後ろに印が付くので、名前の頭が合うフォルダの中を見る。
    const heads = roots.map(root => projectFolderName(root).slice(0, 200))
    for (const entry of await $.fs.list(projects)) {
      if (entry.kind !== 'dir' || !heads.some(head => entry.name.startsWith(head))) continue
      const path = `${projects}/${entry.name}/${id}.jsonl`
      if (await $.fs.exists(path)) return path
    }
    return undefined
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  let entries: Entry[] = []
  // Assistant row key -> the key of the prompt it answers, from the transcript.
  let owners = new Map<string, string>()
  // Prompt id -> the turn it started, from the transcript.
  let turns = new Map<string, Turn>()
  // Prompt row key -> how long its turns took as the engine reported them on
  // ending, for a turn whose turn_duration row the transcript lacks yet.
  const reported = new Map<string, number>()
  // Prompt row key -> how its turn ended as the engine reported it, and whether the
  // newest prompt's turn is running now.
  const ended = new Map<string, Outcome>()
  let isRunning = false
  // How many prompts were listed when the session last came to rest (a turn
  // ended, or the session started), and whether the running turn is a
  // continuation with no typed text. A new prompt's turn may start before its
  // row is stored, so the newest entry is the running turn's own only once a
  // prompt has been listed since the rest; text alone cannot tell, since the
  // person may send the same text twice.
  let listedAtRest = 0
  let isContinuation = false
  // The text of the prompt that started the main loop's latest turn, and the
  // id of its entry once its row is drawn (see listDrawn).
  let turnText = ''
  let starter: string | undefined
  // The entry of the prompt that started the latest turn, not the newest,
  // since a prompt delivered into the turn comes after it, with the same text
  // or not.
  const turnEntry = () => {
    const started = entries.find(entry => entry.id === starter)
    if (started) return started
    for (let i = entries.length - 1; i >= 0; i--) if (turnText && entries[i]!.text === turnText) return entries[i]
    return entries[entries.length - 1]
  }
  const isRunningFor = (id: string) => {
    if (!isRunning || turnEntry()?.id !== id) return false
    return isContinuation || entries.length > listedAtRest
  }
  // A prompt's turn as the rail shows it: the transcript's record, completed
  // by what the engine reported before the transcript had it.
  // prompt-trail: 記録にそのターンの turn_duration の行があれば、終わり方も記録だけで決める（engine の知らせは
  // 使わない）。engine の知らせは「どのプロンプトのターンか」を推して当てているので、外れることがある:
  // 送ってすぐ取り消され、同じ文で送り直されたプロンプト（記録では本線から外れる）の「中断」が、
  // 送り直した方や 1 つ前のプロンプトに付くなど。
  const turnOf = (id: string): Turn | undefined => {
    const turn = turns.get(id)
    const isFiled = turn?.durationMs !== undefined
    const ms = turn?.durationMs ?? reported.get(rowKey(id))
    const outcome = isRunningFor(id) ? 'running' : (turn?.outcome ?? (isFiled ? undefined : ended.get(rowKey(id))))
    if (!turn && ms === undefined && outcome === undefined) return undefined
    return { ...emptyTurn(), ...turn, ...(ms === undefined ? {} : { durationMs: ms }), ...(outcome ? { outcome } : {}) }
  }
  // The transcript rows (prompts, replies, tool rows) the viewport shows, by
  // component and the id each is drawn under: the key its prompt is found by,
  // where it is on screen, and when it said so. A row reports only when that
  // changes, so one that stays whole in the viewport is silent while others
  // scroll past it; it is dropped once it says it left.
  type Shown = { name: string; key: string; first: number; order: number }
  const onScreen = new Map<string, Shown>()
  let reports = 0
  // The row key of the prompt being read, kept while no known row shows.
  let reading: string | undefined
  // The prompt the rail last drew as being read, and the redraw waiting for
  // reports to settle.
  let drawnCurrent = -1
  const settle: Settle = {}
  // The prompt a jump landed on, read while the rows that came into view as it
  // landed are all that show: one near the end cannot reach the viewport's
  // top, so rows of earlier prompts stay above it. `shown` holds those rows'
  // prompts; `isSettled` once they had SETTLE_MAX_MS to report.
  let landed: { key: string; shown: Set<number>; isSettled: boolean } | undefined
  // Prompts whose rows the surface does not draw, learnt from a refused jump.
  const unreachable = new Set<string>()
  // Notices a session gives once (see jumpTo).
  const notices = { isUnscrollableSaid: false }
  const seen: Seen = unseen()
  // Row key -> the id a prompt's row was last drawn under (see drawnRow).
  const drawn = new Map<string, string>()
  // The ids of the prompts the last transcript read listed.
  let filed = new Set<string>()

  // prompt-trail: コマンドの一覧（$.command.list()）。画面に描かれた行と記録の行を結び付けるときと、
  // まだ記録に書かれていない仮の行の判定だけに使う。記録の行がコマンドかどうかは記録の印で決める（startsTurn）。
  // 取れないとき（undefined）は isSlashCommand の判定に戻す。
  let commandNames: Set<string> | undefined
  let unknownRefreshedAt = 0
  // 画面に描かれたコマンドの行（描かれた id -> 打った文）。記録のコマンドの行と文・順番で結び付ける（rebind）。
  const commandRows = new Map<string, string>()
  // 一覧に無い `/名前` の行。一覧を取り直してから、コマンドかプロンプトかを決める。
  const undecided = new Map<string, { text: string; onScreen: { first: number } | null | undefined }>()
  // プロンプトの row key -> そのターンの最初の返事の行の id（記録から）と、返事の行が描かれた id。
  let replies = new Map<string, string>()
  const drawnReplies = new Map<string, string>()

  const addPrompt = (id: string, text: string) => {
    // A new prompt is drawn under a provisional id before it is stored, then
    // again under its uuid: list the stored row only, so a repeated prompt
    // ("continue" twice) still gets an entry of its own.
    if (id === PROVISIONAL_ID || entries.some(entry => rowKey(entry.id) === rowKey(id))) return false
    entries = [...entries, { id, text }]
    return true
  }

  // A prompt that does not go straight into a turn (queued behind the running
  // one, delivered into it, or sent from Remote Control) is drawn under ids the
  // engine never stores before its stored row comes. Its entry is pending
  // meanwhile: rows drawn with its text are other names of it (row key ->
  // entry id), and its stored row takes its place in the list.
  const pending = new Set<string>()
  const aliases = new Map<string, string>()
  // Texts of prompts sent and not stored yet: from prompt.submit or
  // session.receive until the stored row is drawn or the main loop rests.
  const waiting = new Set<string>()
  // The text of the prompt last drawn under the provisional id, until its
  // stored row is drawn.
  let provisional: string | undefined
  // Entries added since the last notification, placeholder or turn edge, and
  // when: the engine may draw a queued prompt's first row before its
  // notification, which then takes it for that prompt's.
  let lately: { id: string; at: number }[] = []
  // When each waiting text's notification came, and the pending entries
  // delivered into the running turn: a row of theirs drawn well after the
  // notification is the attachment the turn read, and no provisional row
  // follows, so the turn's end leaves them pending no more.
  const notifiedAt = new Map<string, number>()
  const delivered = new Set<string>()

  const pendingWith = (text: string) => entries.find(entry => pending.has(entry.id) && entry.text === text)
  // The entry a drawn row belongs to, by its own key or as another name.
  const entryKeyOf = (key: string) => {
    if (entries.some(entry => rowKey(entry.id) === key)) return key
    const id = aliases.get(key)
    return id === undefined ? key : rowKey(id)
  }

  // A prompt with `text` was sent: its rows are pending until the stored one
  // is drawn. True when the list changed.
  const noteSent = (text: string) => {
    waiting.add(text)
    const now = Date.now()
    notifiedAt.set(text, now)
    const fresh = new Set(lately.filter(item => now - item.at <= LATELY_MS).map(item => item.id))
    lately = []
    const own = entries.filter(entry => fresh.has(entry.id) && entry.text === text && !pending.has(entry.id))
    const held = pendingWith(text) ?? own[0]
    if (!held || own.length === 0) return false
    pending.add(held.id)
    const others = new Set(own.filter(entry => entry !== held).map(entry => entry.id))
    for (const id of others) aliases.set(rowKey(id), held.id)
    entries = entries.filter(entry => !others.has(entry.id))
    return others.size > 0
  }

  // List a prompt row as it is drawn; true when the list changed.
  const listDrawn = (id: string, text: string) => {
    if (id === PROVISIONAL_ID) {
      provisional = text
      lately = []
      return false
    }
    const key = rowKey(id)
    if (entries.some(entry => rowKey(entry.id) === key)) {
      // A stored row a transcript read listed first still ends its prompt.
      if (provisional === text) {
        provisional = undefined
        waiting.delete(text)
        if (isRunning) starter = entries.find(entry => rowKey(entry.id) === key)?.id
      }
      return false
    }
    const alias = aliases.get(key)
    if (alias !== undefined) {
      drawn.set(rowKey(alias), id)
      return false
    }
    if (provisional === text) {
      provisional = undefined
      waiting.delete(text)
      if (isRunning) starter = id
      const held = pendingWith(text)
      if (!held) return addPrompt(id, text)
      // The stored row takes the place of the entry that waited for it.
      entries = entries.map(entry => (entry === held ? { id, text } : entry))
      pending.delete(held.id)
      for (const [name, target] of aliases) if (target === held.id) aliases.set(name, id)
      aliases.set(rowKey(held.id), id)
      return true
    }
    if (waiting.has(text)) {
      const held = pendingWith(text)
      if (held) {
        // Another row of the waiting prompt; a jump goes to the one drawn last.
        aliases.set(key, held.id)
        drawn.set(rowKey(held.id), id)
        if (isRunning && Date.now() - (notifiedAt.get(text) ?? Date.now()) > LATELY_MS) delivered.add(held.id)
        return false
      }
      pending.add(id)
      return addPrompt(id, text)
    }
    const isAdded = addPrompt(id, text)
    if (isAdded) lately = [...lately, { id, at: Date.now() }]
    // A turn's prompt drawn with no provisional row, as the session's first.
    if (isAdded && isRunning && starter === undefined && text === turnText) starter = id
    return isAdded
  }

  // Record one onScreen report: where a row is on screen, or null once it left.
  // Rows drawn while a subagent's transcript is in view are not the main
  // conversation's, which alone the rail lists. Returns the row when it says
  // it is cut at the viewport's top, for dropAbove to confirm.
  const see = (component: string, id: string, place: { first: number } | null) => {
    if (viewAgent !== undefined) return undefined
    const name = `${component}\u0000${id}`
    if (place === null) {
      onScreen.delete(name)
      if (landed && !isLandedShown()) landed = undefined
      return undefined
    }
    const row = { name, key: rowKey(id), first: place.first, order: ++reports }
    onScreen.set(name, row)
    noteLandedRow(row.key)
    return row.first > 0 ? row : undefined
  }

  // The index of the prompt a drawn row belongs to, a reply counting as its
  // prompt's; undefined for a row that places no one.
  const indexOfRow = (key: string, promptIndex: Map<string, number>) => {
    if (key === PROVISIONAL_ID) return undefined
    const id = entryKeyOf(key)
    const ownerId = owners.get(id)
    // A reply or tool row the transcript read does not know was written
    // after it: the Stop hook reads before the turn's last reply is stored,
    // and a running turn's rows come later still. A turn's start reads the
    // file again, so only the newest turn can own it.
    return promptIndex.get(id) ?? (ownerId === undefined ? entries.length - 1 : promptIndex.get(ownerId))
  }
  const promptIndexes = () => new Map(entries.map((entry, i) => [rowKey(entry.id), i]))

  const landedIndex = () => (landed ? entries.findIndex(entry => rowKey(entry.id) === landed?.key) : -1)
  const isLandedShown = () => {
    const i = landedIndex()
    const promptIndex = promptIndexes()
    return i >= 0 && [...onScreen.values()].some(row => indexOfRow(row.key, promptIndex) === i)
  }
  // A row of a prompt that was not in view as the jump landed: the person
  // scrolled, so the top row says who is read again.
  const noteLandedRow = (key: string) => {
    if (!landed) return
    const i = indexOfRow(key, promptIndexes())
    if (i === undefined) return
    if (!landed.isSettled) landed.shown.add(i)
    else if (!landed.shown.has(i)) landed = undefined
  }

  // The prompt of the row that last said it is cut at the viewport's top: that
  // row is the top one, so a row of an earlier prompt still listed left
  // without saying so, as rows do in a jump. Unless a row of an earlier prompt
  // said it is on screen since: the viewport then moved above the cut row,
  // which left without saying so itself.
  const topIndex = (promptIndex: Map<string, number>) => {
    const rows = [...onScreen.values()].flatMap(row => {
      const i = indexOfRow(row.key, promptIndex)
      return i === undefined ? [] : [{ i, first: row.first, order: row.order }]
    })
    let top: (typeof rows)[number] | undefined
    for (const row of rows) {
      if (row.first <= 0 || (top && row.order < top.order)) continue
      if (rows.some(other => other.i < row.i && other.order > row.order)) continue
      top = row
    }
    return top?.i
  }

  // A row still cut at the viewport's top a while after it said so is the top
  // one: drop the rows of earlier prompts for good, so they cannot come back
  // when it turns whole. Not sooner: a remounted row replays where it was last
  // seen and says where it is a frame later. Not when a row of an earlier
  // prompt said it is on screen since, as then the viewport moved above it.
  const dropAbove = (cut: Shown) => {
    const row = onScreen.get(cut.name)
    if (!row || row.first <= 0) return
    const promptIndex = promptIndexes()
    const top = indexOfRow(row.key, promptIndex)
    if (top === undefined) return
    const isAbove = (other: Shown) => (indexOfRow(other.key, promptIndex) ?? top) < top
    if ([...onScreen.values()].some(other => other.order > row.order && isAbove(other))) return
    for (const [name, other] of onScreen) if (isAbove(other)) onScreen.delete(name)
  }

  // Where the person is reading: the prompt that the topmost row on screen
  // belongs to. Kept while no known row shows.
  const currentIndex = () => {
    const jumped = landedIndex()
    if (jumped >= 0) {
      reading = landed?.key
      return jumped
    }
    landed = undefined
    const promptIndex = promptIndexes()
    // Rows above the top one are read past until it is confirmed (see dropAbove).
    const top = topIndex(promptIndex)
    let best = -1
    for (const row of onScreen.values()) {
      const i = indexOfRow(row.key, promptIndex)
      if (i === undefined || (top !== undefined && i < top)) continue
      if (best < 0 || i < best) best = i
    }
    const entry = entries[best]
    if (entry) reading = rowKey(entry.id)
    if (reading === undefined) return -1
    // By key, and through another name, so a stored row that takes a pending
    // entry's place, or a rewind that drops an earlier prompt, keeps it.
    const key = entryKeyOf(reading)
    return entries.findIndex(entry => rowKey(entry.id) === key)
  }
  // Whether the rail's drawing no longer shows the prompt being read.
  const isDrawnStale = () => currentIndex() !== drawnCurrent

  // After a jump lands, the rows before it left and the prompt jumped to is
  // at the top, though rows may not say so: a row that stays whole is silent,
  // and one that unmounts may never report it left.
  const landOn = (id: string, target: string, index: number) => {
    onScreen.clear()
    const name = `UserMessage\u0000${target}`
    onScreen.set(name, { name, key: rowKey(target), first: 0, order: ++reports })
    reading = rowKey(id)
    const jump = { key: rowKey(id), shown: new Set([index]), isSettled: false }
    landed = jump
    return jump
  }

  // prompt-trail: 記録のコマンドの行（ターンが走るもの）に、画面に描かれた `❯ /code-review …` の行を、
  // 打った文と順番（同じ文の n 番目どうし）で結び付ける。結び付くと、その描かれた id へ飛べ、読んでいる位置も追える。
  const rebind = () => {
    for (const [entryId, drawnId] of bindCommandRows(entries, commandRows)) {
      drawn.set(rowKey(entryId), drawnId)
      aliases.set(rowKey(drawnId), entryId)
    }
  }

  // 描かれた行の文がコマンドか: 'command' / 'prompt' / 'unknown'（一覧に無い `/名前`）。
  // 記録がコマンドの行と決めた文は、一覧からあとで消えても（または一覧が取れなくなっても）コマンドのまま。
  const statusOf = (text: string): 'command' | 'prompt' | 'unknown' => {
    if (!text.startsWith('/')) return 'prompt'
    if (entries.some(entry => entry.command && entry.text === text)) return 'command'
    if (!commandNames) return isCommandText(text, undefined) ? 'command' : 'prompt'
    if (isCommandText(text, commandNames)) return 'command'
    return slashName(text) === undefined ? 'prompt' : 'unknown'
  }

  // 画面に描かれた行を扱った結果: 読んでいる位置の報告（onScreen の cut）を流すか、並びが変わったか。
  // `$` はフックと最上位の関数にしか渡せないので、続きの処理（afterReport・再描画）は呼び出し側が flushRows で行う。
  type Out = { reported: boolean; cut: Shown | undefined; changed: boolean }
  // 画面に描かれたコマンドの行を覚える（プロンプトとしては並べない）。
  const takeCommandRow = (component: string, id: string, text: string, onScreen: { first: number } | null | undefined): Out => {
    if (id === PROVISIONAL_ID) return { reported: false, cut: undefined, changed: false }
    commandRows.set(id, text)
    rebind()
    return { reported: onScreen !== undefined, cut: onScreen === undefined ? undefined : see(component, id, onScreen), changed: false }
  }
  // 画面に描かれたプロンプトの行を並べる。
  const takePromptRow = (component: string, id: string, text: string, onScreen: { first: number } | null | undefined): Out => {
    const changed = listDrawn(id, text)
    return { reported: onScreen !== undefined, cut: onScreen === undefined ? undefined : see(component, id, onScreen), changed }
  }

  // 取り直した一覧を受け取る（取れなければ undefined: isSlashCommand に戻す）。取り直す前に決められなかった行を決める。
  const acceptCommands = (names: Set<string> | undefined): Out[] => {
    commandNames = names
    const outs: Out[] = []
    for (const [id, row] of [...undecided]) {
      undecided.delete(id)
      outs.push(statusOf(row.text) === 'command' ? takeCommandRow('UserMessage', id, row.text, row.onScreen) : takePromptRow('UserMessage', id, row.text, row.onScreen))
    }
    rebind()
    return outs
  }

  // 描かれたユーザーの行を、コマンドかプロンプトかに振り分ける。askRefresh: 一覧に無い名前なので取り直してほしい。
  const takeUserRow = (id: string, text: string, onScreen: { first: number } | null | undefined): Out & { askRefresh: boolean } => {
    const status = statusOf(text)
    if (status === 'command') return { ...takeCommandRow('UserMessage', id, text, onScreen), askRefresh: false }
    if (undecided.has(id)) {
      undecided.set(id, { text, onScreen })
      return { reported: false, cut: undefined, changed: false, askRefresh: false }
    }
    if (status === 'unknown' && Date.now() - unknownRefreshedAt >= UNKNOWN_REFRESH_MS) {
      // 一覧に無い名前: 増えたばかりのコマンドかもしれないので、一度取り直してから決める。
      unknownRefreshedAt = Date.now()
      undecided.set(id, { text, onScreen })
      return { reported: false, cut: undefined, changed: false, askRefresh: true }
    }
    return { ...takePromptRow('UserMessage', id, text, onScreen), askRefresh: false }
  }

  // Whether the transcript read knows a drawn row, as a prompt or a reply.
  const isKnownRow = (key: string) => {
    const id = entryKeyOf(key)
    return entries.some(entry => rowKey(entry.id) === id) || owners.has(id)
  }

  // The rail's sites say whose transcript is in view; the rows a switch
  // leaves were another transcript's, and those it brings report anew.
  const noteView = (agentId: string | undefined) => {
    if (agentId !== viewAgent) {
      onScreen.clear()
      landed = undefined
    }
    viewAgent = agentId
  }

  // A change of the setting reloads this module with the new value.
  let mode: Mode = isMode(options.mode) ? options.mode : 'horizontal'
  // The subagent whose transcript is in view, as the rail's sites last drew;
  // undefined for the main conversation, whose rows alone the rail lists.
  let viewAgent: string | undefined
  // Whether the session started on the terminal, whose band carries the
  // horizontal rail alone; elsewhere the pane stays open beside it.
  let isTerminal = false
  // Whether the horizontal band was last drawn on a grid of cells (the
  // terminal); the focus event does not say which surface it came from.
  let isBandOnGrid = true
  let railColumns = 0
  // The horizontal bar whose card the text line shows, while the ring is on
  // it, and the timer that stops showing it.
  let ringed: number | undefined
  let ringFade: Timer | undefined
  // prompt-trail: ペインで最後に押した行（PICK_CARD_MS の間）。その下に [ 入力欄へ ] [ コピー ] を出す。
  let panePicked: number | undefined
  let panePickFade: Timer | undefined
  const unring = () => {
    ringFade?.cancel()
    ringFade = undefined
    ringed = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      // Named after the plugin: a plugin's commands share one namespace with
      // every other plugin's and the built-ins, so a generic name would collide.
      name: 'prompt-trail',
      description:
        'プロンプトの並びを出す（horizontal: 入力欄の上 / vertical: 会話の横 / off）。next・prev・first・last・番号・find <語> でそのプロンプトへ飛ぶ。fill・copy で入力欄へ入れる・コピー。help で説明と色の凡例',
      argumentHint: USAGE,
      // Runs while a turn streams, so next and prev move through it then too.
      immediate: true,
    })
    // Argument-free, so a keybinding can name them (`command:prompt-trail-next`):
    // a binding runs a command bare.
    for (const [name, way] of STEP_COMMANDS) {
      await $.command.register({ name, description: way === 'next' ? '次のプロンプトへ飛ぶ（prompt-trail）' : '前のプロンプトへ飛ぶ（prompt-trail）', immediate: true })
    }
    isTerminal = e.surface === 'terminal'
    // prompt-trail: コマンドの一覧は、セッション開始（プラグインの再読み込みのあとも）で取り直す。
    await reloadCommands($, acceptCommands, settle, dropAbove, isDrawnStale)
    // Move a mode an earlier version stored into the setting, once. Writing
    // the setting reloads this module, so everything after it is best effort.
    const stored = await $.store.get(LEGACY_MODE_KEY)
    if (stored !== undefined) await $.store.delete(LEGACY_MODE_KEY)
    if (isMode(stored) && stored !== mode) {
      mode = stored
      await writeMode($, mode)
    }
    // A mode kept for this session only outlives a reload of this module.
    const kept = await $.store.get(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`)
    if (isMode(kept)) mode = kept
    // Also fired after a hot reload, when the list starts empty: rebuild it from
    // the transcript this session's classic SessionStart remembered.
    // prompt-trail: 覚えていなければ（セッションの途中で読み込まれた、classic.* が届かない）、置き場所の決まりから探して覚える。
    const transcriptPath = await transcriptPathOf($, place)
    if (transcriptPath !== undefined) await readAndMerge($, seen, merge, transcriptPath)
    if (!isRunning) listedAtRest = entries.length
    // Unasked, the engine seats a pane only from 144 columns (110 once the
    // person has opened it with /prompt-trail); below that it waits undrawn.
    await seatRail($, mode, isTerminal)
    return next(e)
  })

  // The prompt a command asks for: its index among the entries, or why none
  // (undefined when the command asks for no prompt).
  const askedIndex = (command: string, asked: string): number | undefined => {
    const way = STEP_COMMANDS.find(([name]) => name === command)?.[1]
    if (way !== undefined || asked === 'next' || asked === 'prev') {
      const dir = way === 'next' || asked === 'next' ? 1 : -1
      return stepFrom(currentIndex(), entries.length, dir, isUnreachable)
    }
    return pickPrompt(asked, entries.map(entry => entry.text))
  }
  const missingFor = (command: string, asked: string) => {
    if (command === 'prompt-trail-next' || asked === 'next') return 'これより後のプロンプトはありません'
    if (command === 'prompt-trail-prev' || asked === 'prev') return 'これより前のプロンプトはありません'
    if (/^find[\s\u3000]/i.test(asked.normalize('NFKC'))) return `「${asked.normalize('NFKC').replace(/^find[\s\u3000]+/i, '')}」を含むプロンプトはありません`
    return `プロンプト ${asked} はありません`
  }

  // prompt-trail: [ 入力欄へ ] の 2 回目を待っている間の印（fillPrompt）。
  const fillHold: FillHold = { armed: undefined }
  // 番号の無い fill・copy が指すもの: 読んでいるプロンプト、分からなければ最新。
  const currentOrNewest = () => {
    const current = currentIndex()
    return current >= 0 ? current : entries.length - 1
  }

  on('command.run', async ($, e, next) => {
    const isStep = STEP_COMMANDS.some(([name]) => name === e.command)
    if (!isStep && e.command !== 'prompt-trail') {
      const result = await next(e)
      // prompt-trail: プラグイン・スキルの再読み込みで、コマンドの顔ぶれが変わる。
      if (/^reload/.test(e.command)) await reloadCommands($, acceptCommands, settle, dropAbove, isDrawnStale)
      return result
    }
    const asked = isStep ? '' : e.args.trim()
    unring()
    // prompt-trail: help・fill・copy。
    if (/^(help|\?|？|ヘルプ)$/i.test(asked)) return { text: helpText() }
    const reuse = /^(fill|copy)(?:[\s\u3000]+#?(\d+))?$/i.exec(asked.normalize('NFKC'))
    if (reuse) {
      const number = reuse[2]
      const index = number === undefined ? currentOrNewest() : Number(number) - 1
      if (!entries[index]) {
        $.ui.toast(number === undefined ? 'まだプロンプトがありません' : `プロンプト ${number} はありません`)
        return {}
      }
      if (reuse[1]?.toLowerCase() === 'fill') await fillPrompt($, entries, index, fillHold)
      else await copyPrompt($, entries, index)
      return {}
    }
    const index = askedIndex(e.command, asked)
    if (index !== undefined) {
      // The main conversation's rows are not drawn beside a subagent's, so a
      // jump would be refused and wrongly dot a prompt that can be reached.
      if (viewAgent !== undefined) {
        $.ui.toast('飛べるのはメインの会話の中だけです。先にメインの会話に戻ってください')
        return {}
      }
      const entry = entries[index]
      const target = entry && (await jumpFirst($, entry.id, targetsOf(entry), unreachable, notices))
      if (entry && target) {
        const jump = landOn(entry.id, target, index)
        $.clock.after(SETTLE_MAX_MS, () => {
          jump.isSettled = true
        })
        if (isDrawnStale()) await redrawRail($)
      }
      if (!entry) $.ui.toast(missingFor(e.command, asked))
      return {}
    }
    if (asked && !isMode(asked)) {
      $.ui.toast(`使い方: /prompt-trail ${USAGE}`)
      return {}
    }
    // Reopening a rail that is off would only close it again: say how to turn it on.
    if (!asked && mode === 'off') {
      $.ui.toast('いまは off です。/prompt-trail horizontal か /prompt-trail vertical で出します')
      return {}
    }
    if (isMode(asked)) mode = asked
    await seatRail($, mode, isTerminal)
    await redrawRail($)
    // Last: a changed setting reloads this module, which then starts in it.
    if (isMode(asked)) await writeMode($, asked)
    return {}
  })

  // Rebuild the list from the transcript file, whose uuids are the ids the
  // transcript rows are drawn under. A resumed session so lists prompts the
  // surface has not drawn yet; a row drawn but not stored yet stays after them,
  // and one the file holds off the live branch (rewound away) drops out. True
  // when the list or the prompt being read changed, so the rail needs a redraw.
  const merge = (index: TranscriptIndex) => {
    // A turn's details count as the list's: a turn that ends changes its card.
    const listed = (list: Entry[]) => list.map(entry => `${entry.id}\u0000${entry.text}\u0000${turnLine(turnOf(entry.id))}`).join('\u0001')
    const before = { list: listed(entries), current: currentIndex() }
    // An entry whose row, or another name of it, the file holds is listed
    // from the file.
    const known = new Set([...index.known].map(rowKey))
    for (const [name, id] of aliases) if (known.has(name)) known.add(rowKey(id))
    // An entry the last read listed and this one does not is gone from the
    // file (replaced under the rail), not a row drawn before it was stored.
    entries = [...index.prompts, ...entries.filter(entry => !known.has(rowKey(entry.id)) && !filed.has(entry.id))]
    filed = new Set(index.prompts.map(entry => entry.id))
    const ids = new Set(entries.map(entry => entry.id))
    for (const id of pending) if (!ids.has(id) || known.has(rowKey(id))) pending.delete(id)
    for (const [name, id] of aliases) if (!ids.has(id)) aliases.delete(name)
    owners = new Map(index.owners.map(([id, i]) => [rowKey(id), rowKey(index.prompts[i]?.id ?? '')]))
    turns = new Map(index.prompts.map((entry, i) => [entry.id, index.turns[i] ?? emptyTurn()]))
    replies = firstReplies(index)
    rebind()
    return listed(entries) !== before.list || currentIndex() !== before.current
  }

  // prompt-trail: このセッションのトランスクリプトの場所（transcriptPathOf）。
  const place: Place = { at: undefined }

  // A /clear starts the list over.
  const clearList = () => {
    entries = []
    owners = new Map()
    turns = new Map()
    reported.clear()
    ended.clear()
    isRunning = false
    onScreen.clear()
    landed = undefined
    reading = undefined
    drawnCurrent = -1
    unreachable.clear()
    notices.isUnscrollableSaid = false
    drawn.clear()
    commandRows.clear()
    undecided.clear()
    replies = new Map()
    drawnReplies.clear()
    filed = new Set()
    pending.clear()
    aliases.clear()
    waiting.clear()
    provisional = undefined
    lately = []
    turnText = ''
    starter = undefined
    notifiedAt.clear()
    delivered.clear()
    Object.assign(seen, unseen())
  }

  on('classic.SessionStart', async ($, e, next) => {
    place.at = e.transcript_path
    if (e.source === 'clear') {
      clearList()
      await redrawRail($)
    } else {
      await readAndMerge($, seen, merge, e.transcript_path)
    }
    listedAtRest = entries.length
    await rememberTranscript($, e.session_id, e.transcript_path)
    return next(e)
  })

  // prompt-trail: classic.SessionStart が届かない機械でも /clear（と、別のセッションへの切り替え）で並びを空にする。
  // セッションの id が変わるので、次のターンでその id のトランスクリプトを探し直す。
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      clearList()
      place.at = undefined
      listedAtRest = 0
      await redrawRail($)
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    // prompt-trail: セッションの途中で読み込まれ、場所を探せなかったときは、ここで教わった場所を覚える
    // （次に読み込み直されたとき、最初から全部を並べられるように）。
    if (place.at !== e.transcript_path) {
      place.at = e.transcript_path
      if ((await rememberedTranscript($)) !== e.transcript_path) await rememberTranscript($, e.session_id, e.transcript_path)
    }
    await readAndMerge($, seen, merge, e.transcript_path)
    return next(e)
  })

  // A main-loop turn starts (a subagent's run raises none): the newest
  // prompt's turn is running.
  on('turn.start', async ($, e, next) => {
    isRunning = true
    await reloadCommands($, acceptCommands, settle, dropAbove, isDrawnStale)
    // The transcript follows the new turn down from the prompt jumped to.
    landed = undefined
    isContinuation = e.text.trim() === ''
    turnText = e.text.replace(VIEW_CONTEXT, '').trim()
    starter = undefined
    lately = []
    // Every row of the turns before is stored by now: read them, so a row the
    // index does not know can only be this turn's (see currentIndex).
    // prompt-trail: まだ読めていなければ、ここで場所を求める（classic.* が届かない機械や、始めたばかりのセッション）。
    const path = seen.path || (await transcriptPathOf($, place))
    const index = path
      ? await readTranscript($, path, seen, index => {
          if (merge(index)) void redrawRail($)
        })
      : undefined
    if (index) {
      merge(index)
      // A row the file no longer holds (rewound or compacted away) would
      // count as this turn's.
      for (const [name, row] of onScreen) if (!isKnownRow(row.key)) onScreen.delete(name)
    }
    await redrawRail($)
    return next(e)
  })

  // A main-loop turn ended: its prompt is the one that started it (see
  // turnEntry). The transcript's
  // turn_duration row is written after the Stop hook reads the file, so keep
  // the engine's figure and how the turn ended until a later read has them.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // prompt-trail: 打った文で始まったターンなのに、その文のプロンプトがまだ並んでいなければ（行が描かれる前に
    // 取り消された、など）、どのプロンプトのものか分からないので記録しない。本家は最新のプロンプトに付けていた。
    const isOwnerKnown = starter !== undefined || turnText === '' || entries.some(entry => entry.text === turnText)
    const entry = isOwnerKnown ? turnEntry() : undefined
    if (e.agentId === undefined) {
      isRunning = false
      // A prompt still waiting now is queued behind this turn; its rows to
      // come follow its provisional row.
      waiting.clear()
      notifiedAt.clear()
      for (const id of delivered) pending.delete(id)
      delivered.clear()
      lately = []
      listedAtRest = entries.length
      if (entry) {
        // By row key: a prompt drawn under a derived id is listed under its
        // stored uuid once the transcript is read.
        const key = rowKey(entry.id)
        reported.set(key, (reported.get(key) ?? 0) + e.durationMs)
        if (e.reason === 'aborted') ended.set(key, 'interrupted')
        if (e.reason === 'error') ended.set(key, 'error')
      }
      // prompt-trail: classic.Stop が届かない機械でも、ターンの終わりに記録を読む（届くときは 2 度目の読みは
      // ファイルが変わっていなければ何もしない）。
      const path = await transcriptPathOf($, place)
      if (path !== undefined) await readAndMerge($, seen, merge, path)
      // 読んで並んだプロンプトも、休んでいる間の並びに数える（次のターンの「実行中」を読み違えない）。
      if (!isRunning) listedAtRest = entries.length
      await redrawRail($)
    }
    return result
  })

  // A prompt was sent: typed, or delivered from Remote Control. Its rows drawn
  // before the stored one are pending (see listDrawn).
  on('prompt.submit', async ($, e, next) => {
    unring()
    // prompt-trail: 打つたびに一覧を取り直す（途中で足したコマンド・Mod が登録・解除したコマンドに追従）。
    await reloadCommands($, acceptCommands, settle, dropAbove, isDrawnStale)
    const sent = e.text.replace(VIEW_CONTEXT, '').trim()
    if (PROMPT_KINDS.has(e.origin.kind) && statusOf(sent) !== 'command' && noteSent(sent)) await redrawRail($)
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    if (PROMPT_KINDS.has(e.origin.kind) && noteSent(e.text.replace(VIEW_CONTEXT, '').trim())) await redrawRail($)
    return next(e)
  })

  // Record every prompt row as it is drawn, and which rows the viewport shows.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // A slash command's row is drawn as a user row too.
    // prompt-trail: コマンドの行は並べず、記録のコマンドの行との結び付け（rebind）に使う。
    const text = e.props.text.replace(VIEW_CONTEXT, '').trim()
    if (PROMPT_KINDS.has(e.props.origin.kind) && text) {
      if (statusOf(text) !== 'command') drawn.set(rowKey(e.requestId), e.requestId)
      const out = takeUserRow(e.requestId, text, e.props.onScreen)
      flushRows($, [out], settle, dropAbove, isDrawnStale)
      if (out.askRefresh) $.clock.after(0, () => void reloadCommands($, acceptCommands, settle, dropAbove, isDrawnStale))
    }
    return next(e)
  })

  // A reply or a tool row on screen places the person under the prompt it
  // answers. Tool rows are drawn under their tool_use id; a collapsed group
  // counts as its first call.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    drawnReplies.set(rowKey(e.requestId), e.requestId)
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const id = e.props.calls.find(call => call.tool_use_id)?.tool_use_id
    if (id && e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, id, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })

  const isUnreachable = (i: number) => unreachable.has(entries[i]?.id ?? '')

  // A prompt's text and its turn's details on one line `width` cells wide: the
  // text is cut first, down to a few words, then the details name fewer files.
  const withTurn = (entry: Entry, width: number) => {
    const details = turnLine(turnOf(entry.id), width - MIN_CARD_TEXT - ' · '.length)
    if (!details) return oneLine(entry.text, width)
    const room = Math.max(MIN_CARD_TEXT, width - cellWidth(details) - ' · '.length)
    return `${oneLine(entry.text, room)} · ${details}`
  }

  // prompt-trail: そのプロンプトのターンの種類（色分け）。ターンの記録がまだ無ければ undefined。
  const isColored = options.colors !== false
  const kindAt = (i: number): Kind | undefined => {
    const entry = entries[i]
    const turn = entry && turnOf(entry.id)
    return turn ? kindOf(turn) : undefined
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Read so a moved prompt being read draws the pane again (see MOVED).
    await $.state.get(MOVED)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRail = e.props.placement === 'dock' && e.surface === 'terminal'
    noteView(e.props.view.agentId)
    const nextColumns = isRail ? e.props.bodyColumns : 0
    if (nextColumns !== railColumns) {
      // The band decides from this whether it carries the cards.
      railColumns = nextColumns
      redrawRailLater($)
    }
    // The rail lists the main conversation's prompts, which a subagent's
    // transcript does not hold, so pressing one there could not scroll to it.
    if (e.props.view.agentId !== undefined) {
      const hasRoom = !isRail || e.props.bodyColumns >= INLINE_REVEAL_MIN_COLUMNS
      return <Text dimColor wrap="truncate-end">{hasRoom ? 'メインの会話のプロンプトだけを並べます' : '·'}</Text>
    }
    if (entries.length === 0) {
      return <Text dimColor>{isRail ? '·' : 'まだプロンプトがありません'}</Text>
    }
    const current = currentIndex()
    drawnCurrent = current
    // prompt-trail: 行の頭に色の印（1 マス）。押した行（しばらくの間）か読んでいる行の下に、もう 1 行
    // [ 入力欄へ ] [ コピー ] を出す。ホバーで出し入れすると下の行が動くので、ホバーでは出さない。
    const markCells = isColored ? 1 : 0
    const hasActions = e.props.bodyColumns >= PANE_ACTIONS_MIN_COLUMNS
    const actionsAt = hasActions ? (panePicked !== undefined && panePicked < entries.length ? panePicked : current) : -1
    const row = (i: number, button: JSX.Element) => {
      const kind = kindAt(i)
      const line = (
        <Box key={`row-${i}`} flexDirection="row">
          {isColored ? <Text color={kind ? KIND_COLORS[kind] : undefined}>{kind ? MARK : ' '}</Text> : null}
          {button}
        </Box>
      )
      if (i !== actionsAt) return line
      return (
        <Box key={`rows-${i}`} flexDirection="column">
          {line}
          <Box flexDirection="row" paddingLeft={markCells + 2}>
            <Button key={`fill-${i}`} label={FILL_LABEL} onPress={() => {}} />
            <Text> </Text>
            <Button key={`copy-${i}`} label={COPY_LABEL} onPress={() => {}} />
          </Box>
        </Box>
      )
    }
    // Docked on the terminal: one row per prompt, its tick and its text, the
    // whole row pressable. Too narrow for text, ticks alone (the band shows it).
    if (isRail) {
      const hasRoom = e.props.bodyColumns >= INLINE_REVEAL_MIN_COLUMNS
      const width = Math.max(4, e.props.bodyColumns - 4 - markCells)
      return (
        <Box flexDirection="column">
          {entries.map((entry, i) =>
            row(
              i,
              <Button
                key={`jump-${i}`}
                plain
                dimColor={i !== current}
                label={
                  hasRoom
                    ? ` ${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width)}`
                    : ` ${tick(i === current, isUnreachable(i))} `
                }
                hover={{ scope: `prompt-trail-${i}`, inverse: true, dimColor: false }}
                onPress={() => {}}
              />,
            ),
          )}
        </Box>
      )
    }
    // Elsewhere (inline, or a surface with no band for the card): list the text.
    const width = Math.max(8, e.props.bodyColumns - 3 - markCells)
    return (
      <Box flexDirection="column">
        {entries.map((entry, i) =>
          row(
            i,
            <Button
              key={`jump-${i}`}
              plain
              dimColor={i !== current}
              label={`${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width)}`}
              onPress={() => {}}
            />,
          ),
        )}
      </Box>
    )
  })

  // The band above the prompt. Horizontal: the rail itself, a
  // row of ticks with the hovered prompt beside them. Vertical with a dock too
  // narrow to reveal beside a tick: hidden cards the rail's ticks reveal.
  // prompt-trail: 本家は帯を自分の描画で置き換えていた（next を呼ばない）。ここでは先に next(e) で
  // 下の描画を受け取り、band.ts の約束で自分の行を並び順つきの枠（BAND_ORDER.promptTrail）に入れて積み直す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await $.state.get(MOVED)
    noteView(e.props.view.agentId)
    const beneath = await next(e)
    // Nothing while the rail is off, a survey holds the band or a subagent's transcript is in view.
    if (mode === 'off' || e.props.hasSurvey || e.props.view.agentId !== undefined || entries.length === 0) return beneath
    const { Box, Text, Button } = $.ui.resolve(e)
    const slot = slotKey(BAND_ORDER.promptTrail, PLUGIN)
    const stacked = (mine: JSX.Element) => (
      <Box key={BAND_STACK} flexDirection="column">
        {stackBand(beneath, [mine])}
      </Box>
    )
    const cards = (width: number) =>
      entries.map((entry, i) => (
        <Box key={`card-${i}`} display="none" hover={{ scope: `prompt-trail-${i}`, display: 'flex' }}>
          <Text dimColor>{`#${i + 1} `}</Text>
          <Text wrap="truncate-end">{withTurn(entry, width)}</Text>
        </Box>
      ))

    if (mode === 'horizontal') {
      // Two rows: the text line, then the bars beside the prompt. The text line
      // shows the prompt being read, dim, and the hovered one's card painted
      // over it; the bar of the prompt being read is heavy.
      // prompt-trail: 棒の下にもう 1 行、ターンの結果の色の帯を足す（colors がオンのとき）。
      //
      // Only the terminal's grid of cells hides the dim line under a card. A
      // page (the desktop app) paints a card with no background, in a face of
      // its own widths, so the line beneath shows through: there the text line
      // holds the hovered card alone, and the prompt being read is named after
      // the bars. A clicked bar keeps its native ring there beside the hovered
      // one, so the band takes no ring at all (see the band's ui.focus).
      const isCellGrid = e.surface === 'terminal'
      isBandOnGrid = isCellGrid
      const width = Math.max(8, e.props.bodyColumns - 2 - RAIL_INSET)
      const current = currentIndex()
      drawnCurrent = current
      const shownRing = isCellGrid && ringed !== undefined && ringed < entries.length ? ringed : undefined
      // Cells for the bars and their marks: the whole line, or beside the
      // label of the prompt being read, a gap and a few words of it.
      const barCells = isCellGrid ? width : Math.max(MIN_DESKTOP_BARS, width - 1 - MIN_CARD_TEXT)
      // More prompts than cells: a window of bars centered on the prompt being
      // read (the newest when none is known), `‹` and `›` marking what it hides.
      // It stays put while the ring moves: the ring keeps its place in the row,
      // not its bar, so a shifted window would move it to another prompt.
      const isOverflowing = entries.length > barCells
      const capacity = isOverflowing ? barCells - 2 : entries.length
      const center = current >= 0 ? current : entries.length - 1
      const first = Math.min(Math.max(0, center - Math.floor(capacity / 2)), entries.length - capacity)
      const shown = entries.slice(first, first + capacity)
      const hidesAfter = first + capacity < entries.length
      const label = (i: number, room = width) => `#${i + 1} ${oneLine(entries[i]?.text ?? '', room - `#${i + 1} `.length)}`
      // The hovered prompt's card also sums up its turn.
      // prompt-trail: カードは `[ 入力欄へ ] [ コピー ] #3 本文…` の並び。ボタンを頭に置き、本文は残りの幅で切る
      // （幅が足りなければボタンを置かない）。
      const hasActions = width >= ACTIONS_CELLS + CARD_TEXT_WITH_ACTIONS
      // 棒の、棒の行の中での桁（`‹` の分を含む）。見えている窓の外なら undefined。
      const columnOf = (i: number) => (i >= first && i < first + capacity ? (isOverflowing ? 1 : 0) + i - first : undefined)
      // ボタンの前に空ける幅: [ 入力欄へ ] のラベルの真ん中が棒の真上に来るように。右寄りの棒では、
      // 本文に CARD_TEXT_WITH_ACTIONS を残すところまで左へ寄せる。
      const leadOf = (i: number) =>
        hasActions ? Math.max(0, Math.min((columnOf(i) ?? 0) - ACTIONS_LEAD_BACK, width - ACTIONS_CELLS - CARD_TEXT_WITH_ACTIONS)) : 0
      // 左へ伸ばすカードの右端（棒の真上の桁の次）。右半分の棒で、本文に CARD_TEXT_WITH_ACTIONS 以上残るときだけ。
      // 足りない棒（帯がせまい）は右へ伸ばす。
      const leftEndOf = (i: number): number | undefined => {
        const column = columnOf(i)
        if (!isCellGrid || !hasActions || column === undefined) return undefined
        const end = Math.min(width, column + 1)
        return column * 2 >= width && end >= ACTIONS_CELLS_LEFT + CARD_TEXT_WITH_ACTIONS ? end : undefined
      }
      const card = (i: number, cells: number) => {
        const entry = entries[i]
        return entry ? `#${i + 1} ${withTurn(entry, cells - `#${i + 1} `.length)}` : ''
      }
      const actions = (i: number, suffix = '') =>
        hasActions
          ? [
              <Button key={`fill-${i}${suffix}`} label={FILL_LABEL} onPress={() => {}} />,
              <Text key={`gap-fill-${i}${suffix}`}> </Text>,
              <Button key={`copy-${i}${suffix}`} label={COPY_LABEL} onPress={() => {}} />,
              <Text key={`gap-copy-${i}${suffix}`}> </Text>,
            ]
          : []
      // 1 行のカード: 空き（lead）・ボタン・本文。`cells` は行の幅（端末では本文を空白で埋めて、下の行を隠しきる）。
      const cardRow = (i: number, cells: number, suffix = '', lead = 0, isPadded = false) => {
        const leftEnd = isPadded ? leftEndOf(i) : undefined
        const entry = entries[i]
        if (leftEnd !== undefined && entry) {
          // 左へ伸ばす: 空き・本文・補足・#n・ボタン・棒の右の空き。ボタンの右端が棒の真上。
          const tag = ` #${i + 1} `
          const body = `${withTurn(entry, leftEnd - ACTIONS_CELLS_LEFT - cellWidth(tag))}${tag}`
          const gap = Math.max(0, leftEnd - ACTIONS_CELLS_LEFT - cellWidth(body))
          return [
            gap > 0 ? <Text key={`lead-${i}${suffix}`}>{' '.repeat(gap)}</Text> : null,
            <Text key={`text-${i}${suffix}`} wrap="truncate-end">
              {body}
            </Text>,
            <Button key={`fill-${i}${suffix}`} label={FILL_LABEL} onPress={() => {}} />,
            <Text key={`gap-fill-${i}${suffix}`}> </Text>,
            <Button key={`copy-${i}${suffix}`} label={COPY_LABEL} onPress={() => {}} />,
            cells > leftEnd ? <Text key={`rest-${i}${suffix}`}>{' '.repeat(cells - leftEnd)}</Text> : null,
          ]
        }
        const textCells = Math.max(8, cells - lead - (hasActions ? ACTIONS_CELLS : 0))
        const text = card(i, textCells)
        return [
          lead > 0 ? <Text key={`lead-${i}${suffix}`}>{' '.repeat(lead)}</Text> : null,
          ...actions(i, suffix),
          <Text key={`text-${i}${suffix}`} wrap="truncate-end">
            {isPadded ? padTo(text, textCells) : text}
          </Text>,
        ]
      }
      // prompt-trail: 棒と同じ桁に置く、ターンの結果の色の 1 マス。ホバーするとその棒も灯る（同じ組）。
      const stripCell = (i: number) => {
        const kind = kindAt(i)
        return kind ? (
          <Text key={`kind-${i}`} color={KIND_COLORS[kind]} hover={{ scope: `prompt-trail-${i}`, inverse: true }}>
            {STRIP}
          </Text>
        ) : (
          <Text key={`kind-${i}`}> </Text>
        )
      }
      const bars = [
        isOverflowing ? <Text dimColor>{first > 0 ? '‹' : ' '}</Text> : null,
        ...shown.map((entry, offset) => {
          const i = first + offset
          const jump = (
            <Button
              key={`jump-${i}`}
              plain
              dimColor={i !== current}
              label={bar(i === current, isUnreachable(i))}
              hover={{ scope: `prompt-trail-${i}`, inverse: true, dimColor: false }}
              autoFocus={(isCellGrid && i === center) || undefined}
              onPress={() => {}}
            />
          )
          if (!isCellGrid) return jump
          // prompt-trail: 端末では棒ごとに key 付きの Box（棒と、その下の色の 1 マス）を作り、そのカードを Box の中に
          // 絶対配置で置く（文字の行へ 1 行上げ、行の左端まで戻す）。カードは key の無い Box で、ホバーは組（scope）でなく
          // いちばん近い key 付きの Box（この棒の Box）に付く。絶対配置の Box の上のポインタは親の上と数えられるので、
          // 棒・色の 1 マスからカードへ指を上げても、カードのボタンの上でも、カードは出たまま。ほかの棒に指が乗るか、
          // 棒の Box とカードの外（帯の外、棒の右の空き）へ出ると消える。
          const column = columnOf(i) ?? 0
          return (
            <Box key={`bar-${i}`} flexDirection="column">
              {jump}
              {isColored ? stripCell(i) : null}
              <Box position="absolute" top={-1} left={-column} width={width} flexDirection="row" display="none" hover={{ display: 'flex' }}>
                {cardRow(i, width, '', leadOf(i), true)}
              </Box>
            </Box>
          )
        }),
        hidesAfter ? <Text dimColor>›</Text> : null,
      ]
      // デスクトップでは色の 1 マスを棒の下の行に並べる（端末では棒の Box の中）。
      const strip = isColored ? (
        <Box flexDirection="row">
          {isOverflowing ? <Text key="kind-left"> </Text> : null}
          {shown.map((_, offset) => stripCell(first + offset))}
        </Box>
      ) : null
      if (!isCellGrid) {
        // Each bar and mark a cell wide, then a gap.
        const room = width - (isOverflowing ? barCells : entries.length) - 1
        return stacked(
          <Box key={slot} flexDirection="column" paddingLeft={RAIL_INSET}>
            <Box height={1} width={width}>
              {entries.map((_, i) => (
                <Box key={`card-${i}`} flexDirection="row" display="none" hover={{ scope: `prompt-trail-${i}`, display: 'flex' }}>
                  {cardRow(i, width)}
                </Box>
              ))}
            </Box>
            <Box flexDirection="row">
              {bars}
              {/* With no prompt known on screen, the newest: bars alone read as a broken rail. */}
              <Box marginLeft={1}>
                <Text dimColor wrap="truncate-end">{label(center, room)}</Text>
              </Box>
            </Box>
            {strip}
          </Box>,
        )
      }
      return stacked(
        <Box key={slot} flexDirection="column" paddingLeft={RAIL_INSET}>
          <Box height={1} width={width}>
            {/* With no prompt known on screen, the newest: an empty line reads as a broken rail. */}
            {shownRing === undefined ? (
              <Text dimColor wrap="truncate-end">{label(center)}</Text>
            ) : (
              // prompt-trail: 押した棒（フォーカスの枠）のカード。ホバーのカードと同じ並び・同じ位置。
              <Box flexDirection="row">{cardRow(shownRing, width, '-pin', leadOf(shownRing), true)}</Box>
            )}
          </Box>
          {/* prompt-trail: 棒の Box は棒と色の 1 マスの 2 行（色分けがオフなら棒の 1 行）。 */}
          <Box flexDirection="row">{bars}</Box>
        </Box>,
      )
    }

    if (railColumns > 0 && railColumns < INLINE_REVEAL_MIN_COLUMNS) {
      return stacked(
        <Box key={slot} flexDirection="column">
          {cards(Math.max(8, e.props.bodyColumns - 8))}
        </Box>,
      )
    }
    return beneath
  })

  // The band holds the keyboard after a click or ctrl+x tab: the ring starts
  // on the bar of the prompt being read, the arrows move it, Enter jumps. A
  // scroll is refused here (it is no press), so the text line shows the
  // ringed prompt's card instead, for RING_CARD_MS after each move.
  on('ui.focus', { component: 'AbovePrompt', plugin: PLUGIN }, async ($, e, next) => {
    if (mode !== 'horizontal') return next(e)
    // A page keeps a clicked bar's ring beside the hovered one: two lit at once.
    if (!isBandOnGrid) return { deny: 'prompt-trail: この表示面では棒はクリックで押す（フォーカスの枠は付けない）' }
    const result = await next(e)
    const index = Number(/^jump-(\d+)/.exec(e.element ?? '')?.[1])
    if (result.deny || !Number.isInteger(index)) return result
    unring()
    ringed = index
    ringFade = $.clock.after(RING_CARD_MS, () => {
      unring()
      void redrawRail($)
    })
    await redrawRail($)
    return result
  })

  // In the pane, a ringed row and the row under the pointer light at once and
  // read as two highlights. Keep the ring off the rows; a click still presses,
  // and /prompt-trail next and prev are its keyboard route. The engine's own
  // stops (the close mark, the tabs) carry no plugin, so the matcher leaves
  // them be.
  on('ui.focus', { component: 'Pane', requestId: PANE, plugin: PLUGIN }, async () => ({
    deny: 'prompt-trail: 行はクリックで押す（フォーカスの枠は付けない）',
  }))

  // prompt-trail: 飛び先の候補（前から試す）。ふつうのプロンプトは描かれた行。
  // コマンドの行は、結び付いた描かれた `❯ /code-review …` の行、なければそのターンの最初の返事の行、
  // どちらも無ければ記録の行の id（描かれていないので断られ、点線になる）。
  const targetsOf = (entry: Entry): string[] => jumpTargets(entry, drawn, replies, drawnReplies)

  // Scroll from the press dispatch itself (a click).
  on('ui.press', { plugin: PLUGIN }, async ($, e, next) => {
    // prompt-trail: [ 入力欄へ ] [ コピー ]。棒の位置へは飛ばない。
    const action = /^(fill|copy)-(\d+)/.exec(e.element)
    if (action) {
      const index = Number(action[2])
      if (action[1] === 'fill') await fillPrompt($, entries, index, fillHold)
      else await copyPrompt($, entries, index, e.surface)
      return next(e)
    }
    const index = Number(/^jump-(\d+)/.exec(e.element)?.[1])
    unring()
    const entry = entries[index]
    const target = entry && (await jumpFirst($, entry.id, targetsOf(entry), unreachable, notices))
    if (entry && target) {
      const jump = landOn(entry.id, target, index)
      $.clock.after(SETTLE_MAX_MS, () => {
        jump.isSettled = true
      })
      if (isDrawnStale()) await redrawRail($)
    }
    // prompt-trail: ペインで行を押したら、その行の下にしばらく [ 入力欄へ ] [ コピー ] を出す。
    if (entry && e.component === 'Pane') {
      panePickFade?.cancel()
      panePicked = index
      panePickFade = $.clock.after(PICK_CARD_MS, () => {
        panePicked = undefined
        panePickFade = undefined
        void redrawRail($)
      })
      await redrawRail($)
    }
    // prompt-trail: 端末の帯で棒を押したら、そのカードをしばらく文字の行に残す（ボタンまで指を動かせるように）。
    if (entry && e.component === 'AbovePrompt' && isBandOnGrid && mode === 'horizontal') {
      ringed = index
      ringFade = $.clock.after(PICK_CARD_MS, () => {
        unring()
        void redrawRail($)
      })
      await redrawRail($)
    }
    return next(e)
  })
}
