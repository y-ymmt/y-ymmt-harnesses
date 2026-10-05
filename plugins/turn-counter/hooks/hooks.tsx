/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// エンジンは JSX を大域の `h` で組む。上のプラグマは、tsconfig を読まない場所から
// `bun test` したときも同じ組み方にするためのもの。
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  CLAUDE_ORANGE,
  DENY_FLASH,
  FLASH_MS,
  isMainSpinner,
  nextTurnOf,
  staleTurnKeysOf,
  turnKeyOf,
  turnTextOf,
} from './zawa'
import type { Flash } from './zawa'

/** ざわっ！の消灯を見直す間隔（ミリ秒）。 */
const REFRESH_MS = 1000

/**
 * このセッションぶんの状態。register() が 1 つ作り、フックとタイマーが共有する。
 */
type Zawa = {
  /** メインループのターンが走っているか。 */
  isTurnRunning: boolean
  /** 今のターン番号（1 始まり）。まだ数えていなければ 0。 */
  turn: number
  /** そのターン番号を数えたセッションの id。取れなければ null。 */
  sessionId: string | null
  /** 出しているざわっ！と、その消灯時刻。 */
  flash: Flash | null
  flashUntilMs: number
  /**
   * これまでに起きたサブエージェントの id。
   *
   * サブエージェントの画面のスピナーは差し替えない（`requestId` がこの id）。
   */
  readonly subagentIds: Set<string>
  /** セッションで回しているタイマー。二重に張らないための番人でもある。 */
  readonly timers: Timer[]
}

/**
 * メインループのターンを 1 つ数え、`$.store` に残す。
 *
 * 鍵はセッション id（`$.session.id()`）ごと。再開したセッションは同じ id なので
 * 続きから、新規と `/clear` は新しい id なので 1 から数える（`/clear` では
 * `session.start` が鳴らないので、毎ターン id を引き直して見分ける）。
 * id や store が使えないときは、このプロセスの中での回数で代える。
 *
 * @param $ エンジン
 * @param zawa このセッションの状態
 */
async function countTurn($: EngineInterface, zawa: Zawa): Promise<void> {
  let sessionId: string | null = null

  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = null
  }

  if (sessionId !== zawa.sessionId) {
    zawa.sessionId = sessionId
    zawa.turn = 0
  }

  const counted = zawa.turn + 1

  zawa.turn = counted

  if (sessionId === null) {
    return
  }

  try {
    const key = turnKeyOf(sessionId)
    const turn = Math.max(counted, nextTurnOf(await $.store.get(key)))

    zawa.turn = turn

    // 消してから入れ直し、鍵の並びを「最近使った順」に保つ（古いものから捨てるため）。
    await $.store.delete(key)
    await $.store.set(key, turn)

    for (const stale of staleTurnKeysOf(await $.store.keys())) {
      await $.store.delete(stale)
    }
  } catch {
    // store が使えなくても、このプロセスの中での数は出す。
  }
}

/**
 * ざわっ！の寿命を見直し、消えたら描き直す。
 *
 * @param $ エンジン
 * @param zawa このセッションの状態
 */
async function expireFlash($: EngineInterface, zawa: Zawa): Promise<void> {
  if (zawa.flash === null) {
    return
  }

  if ((await $.clock.now()) >= zawa.flashUntilMs) {
    zawa.flash = null
    $.ui.invalidate('ui.render')
  }
}

/**
 * ざわっ！を焚き、すぐ描き直す。
 *
 * @param $ エンジン
 * @param zawa このセッションの状態
 * @param flash 出す一言
 * @returns 焚いた時刻
 */
async function ignite($: EngineInterface, zawa: Zawa, flash: Flash): Promise<number> {
  const nowMs = await $.clock.now()

  zawa.flash = flash
  zawa.flashUntilMs = nowMs + FLASH_MS
  $.ui.invalidate('ui.render')

  return nowMs
}

/**
 * ざわ・・ざわ・・。
 *
 * - `Spinner`（terminal）を、このセッションのターン数（`ターン 12`）＋元の文言（薄字）に
 *   差し替える
 * - ツールが拒否されたら「ざわっ！」を数秒だけ、ターン数の
 *   代わりに出す
 *
 * @param on エンジンの登録口
 */
export const register: Register = on => {
  const zawa: Zawa = {
    isTurnRunning: false,
    turn: 0,
    sessionId: null,
    flash: null,
    flashUntilMs: 0,
    subagentIds: new Set<string>(),
    timers: [],
  }

  on('session.start', ($, e, next) => {
    if (zawa.timers.length === 0) {
      zawa.timers.push(
        $.clock.every(REFRESH_MS, () => {
          void expireFlash($, zawa)
        }),
      )
    }

    return next(e)
  })

  // サブエージェントの実行は turn.start を起こさないので、ここに来るのはメインループのターンだけ。
  on('turn.start', async ($, e, next) => {
    zawa.isTurnRunning = true
    await countTurn($, zawa)

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      zawa.isTurnRunning = false
    }

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const checked = await next(e)

    if (checked.decision === 'deny') {
      await ignite($, zawa, DENY_FLASH)
    }

    return checked
  })

  // Read のパス拒否のように、権限判定（tool.check）より手前の入力検証で弾かれた呼び出しや、
  // 権限プロンプトで人が断った呼び出しは、結果側（deny / isError）にしか現れない。ここでも拾う。
  on('tool.call', async ($, e, next) => {
    const called = await next(e)

    const isRefused =
      called.deny !== undefined ||
      (called.isError === true && /denied by your permission|permission/i.test(called.text ?? ''))

    if (isRefused) {
      const nowMs = await ignite($, zawa, DENY_FLASH)

      // 直近の拒否を残す（動作確認用。`$.store.get('lastRefusal')` で読める）。
      void $.store.set('lastRefusal', {
        at: nowMs,
        tool: e.tool,
        deny: called.deny ?? null,
        isError: called.isError === true,
        text: (called.text ?? '').slice(0, 200),
      })
    }

    return called
  })

  // サブエージェントが起きたら id を覚える。その画面のスピナーには手を出さない。
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.agentId !== undefined) {
      zawa.subagentIds.add(spawned.agentId)
    }

    return spawned
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // サブエージェントの画面のスピナーは素のまま。
    if (
      e.surface !== 'terminal' ||
      !isMainSpinner({
        requestId: e.requestId,
        isTurnRunning: zawa.isTurnRunning,
        subagentIds: zawa.subagentIds,
      })
    ) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const nowMs = await $.clock.now()
    const shown = zawa.flash !== null && nowMs < zawa.flashUntilMs ? zawa.flash : null

    // spinnerVerbs に複数行の AA を入れている人が居るので、1 行に均してから薄字で残す。
    const subtitle = (e.props.message ?? e.props.word ?? '').replace(/\s+/g, ' ').trim()

    // 上にターン数（ざわっ！の最中はその一言）、下に元の spinner 文言。
    return (
      <Box flexDirection="column">
        <Text color={shown?.color ?? CLAUDE_ORANGE} bold={shown?.bold ?? false}>
          {shown?.text ?? turnTextOf(zawa.turn)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {subtitle}
        </Text>
      </Box>
    )
  })
}
