/**
 * prompt-trail が本家 prompt-rail に足したもののうち、`$` を使わない部分。
 *
 * - 検索の揺れ（全角/半角・大文字/小文字・ひらがな/カタカナ）をならす `fold`
 * - ターンの結果の種類（色分け）と、その判定・色・凡例
 * - ヘルプの文
 */

/**
 * 検索用に文字の揺れをならす。NFKC（全角英数→半角、半角カナ→全角カナ、合字の分解など）の後、
 * 小文字にし、カタカナをひらがなに寄せ、空白の続きを 1 つにする。
 */
export const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    // ァ(30A1)〜ヶ(30F6) と ヽヾ(30FD-30FE) をひらがなへ。ー（長音）はそのまま。
    .replace(/[ァ-ヶヽヾ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim()

/** `text` が `words` を含むか（`fold` でならしてから比べる）。 */
export const holds = (text: string, words: string): boolean => {
  const needle = fold(words)

  return needle !== '' && fold(text).includes(needle)
}

/**
 * ターンの結果の種類。上ほど優先して色にする（複数当てはまるときは上の 1 つ）。
 *
 * - running: いま走っている
 * - rejected: ツールが拒否された（本人が No を選んだ、許可の設定・auto mode の判定で止められた）。
 *   本人の No は「中断」の行も伴うので、中断より上に置かないと拒否が見えない
 * - interrupted: 本人が止めた（Esc）
 * - failed: ツールが失敗した（is_error）か、API エラーで終わった
 * - edited: ファイルを編集した（Edit / Write / MultiEdit / NotebookEdit が成功した）
 * - quiet: 読むだけ・答えただけ（上のどれでもない）
 */
export type Kind = 'running' | 'rejected' | 'interrupted' | 'failed' | 'edited' | 'quiet'

export const KIND_ORDER: readonly Kind[] = ['running', 'rejected', 'interrupted', 'failed', 'edited', 'quiet']

/** 種類ごとの色（暗い背景でも明るい背景でも読める中くらいの明るさ）。 */
export const KIND_COLORS: Record<Kind, string> = {
  running: '#60a5fa',
  rejected: '#e879f9',
  interrupted: '#facc15',
  failed: '#f87171',
  edited: '#4ade80',
  quiet: '#6b7280',
}

/** 凡例とカードに出す言葉。 */
export const KIND_WORDS: Record<Kind, string> = {
  running: '実行中',
  rejected: '拒否',
  interrupted: '中断',
  failed: '失敗',
  edited: '編集',
  quiet: '読むだけ',
}

/** 種類の判定に使う、ターンの記録の一部。 */
export type TurnFacts = {
  outcome?: 'running' | 'interrupted' | 'error'
  files: readonly string[]
  failed?: number
  rejected?: number
}

/** ターンの記録から種類を決める（優先順は `Kind` の説明のとおり）。 */
export const kindOf = (turn: TurnFacts): Kind => {
  if (turn.outcome === 'running') return 'running'
  if ((turn.rejected ?? 0) > 0) return 'rejected'
  if (turn.outcome === 'interrupted') return 'interrupted'
  if ((turn.failed ?? 0) > 0 || turn.outcome === 'error') return 'failed'
  if (turn.files.length > 0) return 'edited'

  return 'quiet'
}

/** 色の帯の 1 マス。棒の真下に置く。 */
export const STRIP = '▀'
/** 縦のペインで行の頭に置く色の印。 */
export const MARK = '▌'

/**
 * ツールの結果のうち「拒否された」もの。Claude Code がトランスクリプトに書く文言で見分ける
 * （本人が No を選んだ・許可の設定で止められた・auto mode の判定で止められた）。
 */
export const REJECTED =
  /^(?:Error: )?(?:The user doesn't want to (?:proceed with|take) this|User rejected tool use|Permission for this action (?:was|has been) denied|Permission to use [\s\S]* has been denied|<tool_use_error>[^<]*denied by your permission settings)/

/** 編集したことになるツールと、そのパスの入力名。 */
export const EDITING_TOOLS: Record<string, 'file_path' | 'notebook_path'> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** 凡例（1 行）。 */
export const legendLine = (): string =>
  KIND_ORDER.map(kind => `${STRIP} ${KIND_WORDS[kind]}`).join('  ')

/** 凡例（色の説明つき、ヘルプ用）。 */
const LEGEND_ROWS: Record<Kind, string> = {
  running: '青: いま走っている',
  rejected: '紫: ツールが拒否された（本人の No・許可の設定・auto mode の判定）',
  interrupted: '黄: 本人が止めた（Esc）',
  failed: '赤: ツールが失敗した、または API エラーで終わった',
  edited: '緑: ファイルを編集した（Edit / Write / MultiEdit / NotebookEdit）',
  quiet: '灰: 読む・答えるだけで、上のどれも起きていない',
}

export const USAGE = '[horizontal|vertical|off|next|prev|first|last|<番号>|find <語>|fill [番号]|copy [番号]|help]'

/** `/prompt-trail help` の返事。 */
export const helpText = (): string =>
  [
    'prompt-trail: このセッションで打ったプロンプトを並べる。棒（行）にホバーで中身とそのターンの結果、クリックでその位置へ飛ぶ。',
    '',
    'コマンド',
    '  /prompt-trail horizontal   入力欄の上の帯に棒の列で出す（既定）',
    '  /prompt-trail vertical     会話の横のペインに 1 行ずつ出す',
    '  /prompt-trail off          出さない',
    '  /prompt-trail next / prev  次・前のプロンプトへ（/prompt-trail-next・/prompt-trail-prev はキー割り当て用）',
    '  /prompt-trail first / last 最初・最新のプロンプトへ',
    '  /prompt-trail 12（#12）    12 番目のプロンプトへ',
    '  /prompt-trail find <語>    語を含む最新のプロンプトへ（全角/半角・大文字/小文字・ひらがな/カタカナは区別しない）',
    '  /prompt-trail fill [番号]  そのプロンプトを入力欄に入れる（送信はしない。番号を省くと読んでいるもの）',
    '  /prompt-trail copy [番号]  そのプロンプトをコピーする',
    '  /prompt-trail help         この説明',
    '',
    '再利用',
    '  ホバーのカード（縦のペインでは行）の [ 入力欄へ ] で入力欄に入れる（打ちかけの文があれば、もう一度押すと置き換える）。',
    '  [ コピー ] でクリップボードへ。棒をクリックすると、そのカードが数秒そのまま残る。',
    '',
    '色（上ほど優先。複数当てはまるときは上の 1 つ）',
    ...KIND_ORDER.map(kind => `  ${STRIP} ${LEGEND_ROWS[kind].replace(':', `（${KIND_WORDS[kind]}）:`)}`),
    '',
    '棒の形: ┃ 読んでいるプロンプト / │ ほか / ┆ 飛べなかったプロンプト（next・prev は飛ばす）',
  ].join('\n')
