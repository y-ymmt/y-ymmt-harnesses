/**
 * 文言まわり: ターン数の行、ざわっ！の見た目、どのスピナーを差し替えるかの判定、
 * ターン数を `$.store` に残すときの鍵の決め方。描画にも `$` にも依存しない。
 */

/** Claude オレンジ。ターン数の行の文字色に使う。 */
export const CLAUDE_ORANGE = '#D97757'

/**
 * ターン数の行の文字。
 *
 * @param turn 今走っているターンを含めた、このセッションのターン番号（1 始まり）
 */
export function turnTextOf(turn: number): string {
  return `ターン ${Math.max(1, Math.trunc(turn))}`
}

/** ざわっとしたときの一言: 文字、色、太字。 */
export type Flash = {
  readonly text: string
  readonly color: string
  readonly bold: boolean
}

/** ツールが拒否されたとき。 */
export const DENY_FLASH: Flash = { text: 'ざわっ！', color: 'red', bold: true }

/**
 * Claude Code が、ツールの実行を利用者や設定が断ったときに返す文言。
 * `EACCES: permission denied` のような実行時エラーは含まない。
 */
const REFUSED =
  /^(?:Error: )?(?:The user doesn't want to (?:proceed with|take) this|User rejected tool use|Permission for this action (?:was|has been) denied|Permission to use [\s\S]* has been denied)|denied by your permission settings/

/**
 * ツール結果の文が、拒否されたことを表すか。
 *
 * @param text `tool.call` の結果の `text`
 */
export function isRefusalText(text: string): boolean {
  return REFUSED.test(text)
}

/** ざわっ！を出しておく長さ（ミリ秒）。 */
export const FLASH_MS = 3000

/** どのスピナーを差し替えるかを決める材料。 */
export type SpinnerOwner = {
  /** そのスピナーの `requestId`（スピナーではエージェント id）。 */
  readonly requestId: string
  /** メインループのターンが走っているか。 */
  readonly isTurnRunning: boolean
  /** これまでに起きたサブエージェントの id。 */
  readonly subagentIds: ReadonlySet<string>
}

/**
 * そのスピナーがメインループのものか。
 *
 * ターン数はメインループのものなので、サブエージェントの画面のスピナーは
 * 素の spinner に任せる。
 *
 * `turn.start` はメインループでしか鳴らない（サブエージェントの実行は
 * `turn.start` を起こさない）ので、ターンが走っていない間に来たスピナーは
 * メインのものではありえない（`$.agent.spawn` を見逃していても弾ける）。
 *
 * @param owner 判断の材料
 */
export function isMainSpinner(owner: SpinnerOwner): boolean {
  return owner.isTurnRunning && !owner.subagentIds.has(owner.requestId)
}

/** ターン数を `$.store` に残すときの鍵の頭。後ろにセッション id が付く。 */
export const TURN_KEY_PREFIX = 'turns.'

/** 覚えておくセッションの数。古いものから捨てる。 */
export const TURN_KEYS_KEPT = 200

/**
 * そのセッションのターン数を残す鍵。
 *
 * セッション id ごとに鍵を分けるのは、同時に開いている別セッションの書き込みで
 * 互いの数を潰さないため（1 つの表にまとめると読み書きのあいだに割り込まれる）。
 *
 * @param sessionId `$.session.id()`
 */
export function turnKeyOf(sessionId: string): string {
  return `${TURN_KEY_PREFIX}${sessionId}`
}

/**
 * 保存済みの値から、次のターンの番号を決める。
 *
 * 再開したセッションは id が同じなので続きから、新規と `/clear` は id が
 * 新しくなるので 1 から数え直す。壊れた値は無かったものとして扱う。
 *
 * @param stored `$.store.get(turnKeyOf(id))` の値
 */
export function nextTurnOf(stored: unknown): number {
  const count = typeof stored === 'number' && Number.isFinite(stored) ? Math.trunc(stored) : 0

  return Math.max(0, count) + 1
}

/**
 * 捨てる鍵。ターン数の鍵のうち、古い（先に入った）ものから `kept` 個を超えるぶん。
 *
 * `$.store.keys()` は入れた順で返るので、書き込むたびに消してから入れ直せば
 * 「最近使った順」になる。
 *
 * @param keys `$.store.keys()`
 * @param kept 残す数
 */
export function staleTurnKeysOf(keys: readonly string[], kept: number = TURN_KEYS_KEPT): string[] {
  const turnKeys = keys.filter(key => key.startsWith(TURN_KEY_PREFIX))

  return turnKeys.slice(0, Math.max(0, turnKeys.length - kept))
}
