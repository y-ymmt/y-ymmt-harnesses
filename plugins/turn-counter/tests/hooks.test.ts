/**
 * hooks.tsx を偽の `$` と `on` で動かすテスト。`bun test` で走る（claude-code/testing に依存しない）。
 *
 *   bun test plugins/turn-counter/tests/
 */
import { beforeAll, describe, expect, test } from 'bun:test'

import { register } from '../hooks/hooks'
import {
  CLAUDE_ORANGE,
  TURN_KEY_PREFIX,
  nextTurnOf,
  staleTurnKeysOf,
  turnKeyOf,
  turnTextOf,
} from '../hooks/zawa'

/** 偽の描画木の 1 要素。エンジンの `h` と同じく `{ type, props, children }`。 */
type Element = {
  readonly type: string
  readonly props: Record<string, unknown>
  readonly children: readonly Node[]
}
type Node = Element | string

/** JSX は大域の `h` で組まれる（tsconfig の jsxFactory）。エンジンと同じ形の木を返す。 */
beforeAll(() => {
  const flat = (children: readonly unknown[]): Node[] =>
    children.flatMap(child =>
      Array.isArray(child)
        ? flat(child)
        : child === null || child === undefined || child === false || child === true
          ? []
          : [typeof child === 'number' ? String(child) : (child as Node)],
    )

  ;(globalThis as Record<string, unknown>)['h'] = (
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): Element => ({ type, props: props ?? {}, children: flat(children) })
  ;(globalThis as Record<string, unknown>)['Fragment'] = 'Fragment'
})

type Hook = (...args: never[]) => unknown
type Registered = { readonly event: string; readonly matcher: Record<string, unknown> | null; readonly hook: Hook }

/** プロセスをまたいで残る `$.store` の代わり。 */
class Store {
  readonly map = new Map<string, unknown>()
  isBroken = false

  get = async (key: string): Promise<unknown> => {
    this.check()

    return this.map.has(key) ? JSON.parse(JSON.stringify(this.map.get(key))) : undefined
  }

  set = async (key: string, value: unknown): Promise<void> => {
    this.check()
    this.map.set(key, JSON.parse(JSON.stringify(value)))
  }

  delete = async (key: string): Promise<void> => {
    this.check()
    this.map.delete(key)
  }

  keys = async (): Promise<string[]> => {
    this.check()

    return [...this.map.keys()]
  }

  private check(): void {
    if (this.isBroken) {
      throw new Error('store unavailable')
    }
  }
}

/**
 * Claude Code のプロセス 1 つぶん。register() を走らせ、イベントを順に流せる。
 *
 * 下（core）の振る舞いは、各イベントでいちばん素直な値を返すだけ。
 */
class Process {
  readonly hooks: Registered[] = []
  readonly timers: { readonly ms: number; readonly fn: () => void }[] = []
  invalidations = 0
  nowMs = 1_000_000
  sessionId: string
  readonly store: Store
  readonly $: Record<string, unknown>

  constructor(sessionId: string, store = new Store()) {
    this.sessionId = sessionId
    this.store = store
    this.$ = {
      clock: {
        now: async () => this.nowMs,
        every: (ms: number, fn: () => void) => {
          this.timers.push({ ms, fn })

          return { cancel: () => undefined }
        },
      },
      session: { id: async () => this.sessionId },
      store: this.store,
      ui: {
        // Raster や Client も表に載せておき、使われていないことを確かめる。
        resolve: () => ({ Box: 'Box', Text: 'Text', Raster: 'Raster', Client: 'Client' }),
        invalidate: () => {
          this.invalidations += 1
        },
      },
    }

    const on = (event: string, matcherOrHook: unknown, maybeHook?: unknown): void => {
      const hook = (maybeHook ?? matcherOrHook) as Hook
      const matcher = maybeHook === undefined ? null : (matcherOrHook as Record<string, unknown>)

      this.hooks.push({ event, matcher, hook })
    }

    ;(register as unknown as (on: unknown, options: unknown) => void)(on, {})
  }

  /** イベントを流す。合うフックが無ければ core の値をそのまま返す。 */
  async emit(event: string, e: Record<string, unknown>, core: (e: unknown) => unknown): Promise<unknown> {
    const found = this.hooks.find(
      ({ event: name, matcher }) =>
        name === event &&
        (matcher === null || Object.entries(matcher).every(([key, value]) => e[key] === value)),
    )
    const next = async (passed: unknown): Promise<unknown> => core(passed)

    return found === undefined
      ? core(e)
      : (found.hook as unknown as (...args: unknown[]) => unknown)(this.$, e, next)
  }

  async sessionStart(): Promise<void> {
    await this.emit('session.start', { cwd: '/tmp', surface: 'terminal', isInteractive: true }, () => ({
      cwd: '/tmp',
    }))
  }

  async turnStart(turnId = 't'): Promise<void> {
    await this.emit('turn.start', { text: 'hi', turnId }, () => ({ turnId }))
  }

  async turnComplete(agentId?: string): Promise<void> {
    await this.emit(
      'turn.complete',
      {
        answer: 'ok',
        durationMs: 1000,
        isAborted: false,
        turnId: 't',
        reason: 'answer',
        ...(agentId === undefined ? {} : { agentId }),
      },
      () => ({}),
    )
  }

  async spawn(agentId: string): Promise<void> {
    await this.emit('agent.spawn', { prompt: 'x' }, () => ({ agentId }))
  }

  async spinner(overrides: Record<string, unknown> = {}): Promise<Node> {
    return (await this.emit(
      'ui.render',
      {
        surface: 'terminal',
        component: 'Spinner',
        requestId: 'main',
        viewport: { columns: 80, rows: 40 },
        props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
        ...overrides,
      },
      () => CORE_SPINNER,
    )) as Node
  }

  /** 張られたタイマーを、`ms` だけ時計を進めながら回す。 */
  async advance(ms: number): Promise<void> {
    const step = Math.min(...this.timers.map(timer => timer.ms))

    for (let passed = 0; passed < ms; passed += step) {
      this.nowMs += step

      for (const timer of this.timers) {
        timer.fn()
      }

      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

/** core が描く素の spinner（差し替えなかったときにそのまま返るもの）。 */
const CORE_SPINNER: Element = { type: 'Text', props: {}, children: ['core:Spinner'] }

/** 木の中の文字列をすべてつなげたもの。 */
function textOf(node: Node): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

/** 木を平らにする。 */
function flatten(node: Node): Element[] {
  return typeof node === 'string' ? [] : [node, ...node.children.flatMap(flatten)]
}

/** 端末の名前付き色（Text の color に文字列で渡せるもの）。 */
const NAMED_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright',
  'cyanBright', 'whiteBright',
])

/**
 * エンジンの木の検証に寄せた確認。落ちる理由を文字列で返す（通れば空）。
 *
 * - 要素は Box と Text だけ（Raster・Client は使わない）
 * - Text の color は文字列（`#RRGGBB` か色名）。数値だと検証に落ちて描画が消える
 * - Text の子は文字列か Text、Box の子は要素
 * - bold・dimColor は boolean
 */
function invalidReasonOf(node: Node, parent: string | null = null): string {
  if (typeof node === 'string') {
    return parent === 'Text' ? '' : `文字列が ${parent ?? '根'} の直下にある`
  }

  if (node.type !== 'Box' && node.type !== 'Text') {
    return `知らない要素 ${node.type}`
  }

  if (parent === 'Text' && node.type !== 'Text') {
    return `Text の中に ${node.type}`
  }

  for (const key of ['color', 'backgroundColor']) {
    const value = node.props[key]

    if (value !== undefined && (typeof value !== 'string' || !(/^#[0-9a-f]{6}$/i.test(value) || NAMED_COLORS.has(value)))) {
      return `${key} が文字列の色でない: ${String(value)}`
    }
  }

  for (const key of ['bold', 'dimColor']) {
    if (node.props[key] !== undefined && typeof node.props[key] !== 'boolean') {
      return `${key} が boolean でない`
    }
  }

  for (const child of node.children) {
    const reason = invalidReasonOf(child, node.type)

    if (reason !== '') {
      return reason
    }
  }

  return ''
}

/** スピナーの木の各行（Box 直下の Text）の文字。 */
function rowsOf(drawn: Node): string[] {
  return typeof drawn === 'string' ? [drawn] : drawn.children.map(textOf)
}

describe('ターン数の数え方', () => {
  test('メインのターンだけを 1 から数え、今のターンを含めた番号を出す', async () => {
    const proc = new Process('session-a')

    await proc.sessionStart()
    await proc.turnStart()
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 1')
    await proc.turnComplete()

    await proc.turnStart()
    // サブエージェントが起きて、そのターンが終わっても数えないし、メインのターンも終わらない。
    await proc.spawn('agent-x')
    await proc.turnComplete('agent-x')
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 2')
    await proc.turnComplete()

    await proc.turnStart()
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 3')
    expect(proc.store.map.get(turnKeyOf('session-a'))).toBe(3)
  })

  test('再開（同じセッション id で別プロセス）は続きから数える', async () => {
    const store = new Store()
    const first = new Process('session-r', store)

    await first.sessionStart()

    for (let turn = 0; turn < 4; turn += 1) {
      await first.turnStart()
      await first.turnComplete()
    }

    const resumed = new Process('session-r', store)

    await resumed.sessionStart()
    await resumed.turnStart()
    expect(rowsOf(await resumed.spinner())[0]).toBe('ターン 5')
  })

  test('新規セッションと /clear（id が変わり session.start は鳴らない）は 1 から', async () => {
    const store = new Store()
    const proc = new Process('session-1', store)

    await proc.sessionStart()
    await proc.turnStart()
    await proc.turnComplete()
    await proc.turnStart()
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 2')
    await proc.turnComplete()

    // /clear: 同じプロセスのまま id だけ変わる。
    proc.sessionId = 'session-2'
    await proc.turnStart()
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 1')
    await proc.turnComplete()

    const fresh = new Process('session-3', store)

    await fresh.sessionStart()
    await fresh.turnStart()
    expect(rowsOf(await fresh.spinner())[0]).toBe('ターン 1')
    expect(store.map.get(turnKeyOf('session-1'))).toBe(2)
    expect(store.map.get(turnKeyOf('session-2'))).toBe(1)
  })

  test('store が使えなくても、このプロセスの中での回数を出す', async () => {
    const store = new Store()
    const proc = new Process('session-b', store)

    store.isBroken = true
    await proc.sessionStart()
    await proc.turnStart()
    await proc.turnComplete()
    await proc.turnStart()
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 2')
  })

  test('鍵の決め方・次の番号・古い鍵の捨て方', () => {
    expect(turnKeyOf('abc')).toBe(`${TURN_KEY_PREFIX}abc`)
    expect(nextTurnOf(undefined)).toBe(1)
    expect(nextTurnOf(7)).toBe(8)
    expect(nextTurnOf('7'), '壊れた値は無かったことに').toBe(1)
    expect(nextTurnOf(-3)).toBe(1)
    expect(turnTextOf(12)).toBe('ターン 12')
    expect(
      staleTurnKeysOf(['lastRefusal', 'turns.a', 'turns.b', 'turns.c'], 2),
      'ターン数の鍵だけを、古い順に',
    ).toEqual(['turns.a'])
    expect(staleTurnKeysOf(['turns.a'], 2)).toEqual([])
  })

  test('覚えておくセッションは上限まで（古いものから捨てる）', async () => {
    const store = new Store()

    for (let index = 0; index < 205; index += 1) {
      store.map.set(turnKeyOf(`old-${index}`), 1)
    }

    const proc = new Process('session-new', store)

    await proc.sessionStart()
    await proc.turnStart()

    const turnKeys = [...store.map.keys()].filter(key => key.startsWith(TURN_KEY_PREFIX))

    expect(turnKeys).toHaveLength(200)
    expect(turnKeys.at(-1)).toBe(turnKeyOf('session-new'))
    expect(store.map.has(turnKeyOf('old-0'))).toBe(false)
  })
})

describe('スピナーの木', () => {
  test('ターン数の行と元の文言が並び、Raster や Client は無く、検証を通る', async () => {
    const proc = new Process('session-t')

    await proc.sessionStart()
    await proc.turnStart()

    const drawn = await proc.spinner({
      props: { word: 'Sauteing', message: '  ▗▄▖\n  ▐█▌  ', suffix: '…', mode: 'thinking' },
    })

    expect(invalidReasonOf(drawn)).toBe('')
    expect(typeof drawn !== 'string' && drawn.type).toBe('Box')
    expect(flatten(drawn).some(element => element.type === 'Raster' || element.type === 'Client')).toBe(false)

    const [turnRow, subtitleRow] = typeof drawn === 'string' ? [] : drawn.children
    const rows = rowsOf(drawn)

    expect(rows, '複数行の文言は 1 行に均す').toEqual(['ターン 1', '▗▄▖ ▐█▌'])
    expect(typeof turnRow !== 'string' && turnRow?.props).toMatchObject({ color: CLAUDE_ORANGE, bold: false })
    expect(typeof subtitleRow !== 'string' && subtitleRow?.props['dimColor'], '元の文言は薄字').toBe(true)

    expect(rowsOf(await proc.spinner())[1], 'message が無ければ word').toBe('Sauteing')
  })

  test('サブエージェントの画面・ターン外・terminal 以外のスピナーは素通し', async () => {
    const proc = new Process('session-s')

    await proc.sessionStart()
    expect(await proc.spinner(), 'ターン外').toBe(CORE_SPINNER)

    await proc.turnStart()
    await proc.spawn('agent-1')
    expect(await proc.spinner({ requestId: 'agent-1' }), 'サブエージェント').toBe(CORE_SPINNER)
    expect(await proc.spinner({ surface: 'desktop' }), 'desktop').toBe(CORE_SPINNER)
    expect(await proc.spinner(), 'メインは差し替える').not.toBe(CORE_SPINNER)

    await proc.turnComplete()
    expect(await proc.spinner(), 'ターンが終われば素通し').toBe(CORE_SPINNER)
  })
})

describe('ざわっ！', () => {
  test('tool.check が deny なら赤の太字「ざわっ！」がターン数の代わりに出て、数秒で戻る', async () => {
    const proc = new Process('session-d')

    await proc.sessionStart()
    await proc.turnStart()
    await proc.emit('tool.check', { tool: 'Bash', input: { command: 'rm -rf /' } }, () => ({
      decision: 'deny',
      reason: 'no',
    }))

    const flashed = await proc.spinner()
    const row = typeof flashed === 'string' ? undefined : flashed.children[0]

    expect(rowsOf(flashed)).toEqual(['ざわっ！', 'Sauteing'])
    expect(typeof row !== 'string' && row?.props).toMatchObject({ color: 'red', bold: true })
    expect(invalidReasonOf(flashed)).toBe('')

    const before = proc.invalidations

    await proc.advance(4_000)

    expect(proc.invalidations - before, '消えるときに 1 回だけ描き直す').toBe(1)
    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 1')
  })

  test('tool.check が ask でも何も出さない（ターン数のまま）', async () => {
    const proc = new Process('session-q')

    await proc.sessionStart()
    await proc.turnStart()
    await proc.emit('tool.check', { tool: 'Bash', input: { command: 'git push' } }, () => ({
      decision: 'ask',
    }))

    expect(rowsOf(await proc.spinner())[0]).toBe('ターン 1')
  })

  test('結果側で拒否された tool.call も「ざわっ！」にし、lastRefusal を残す', async () => {
    const proc = new Process('session-c')

    await proc.sessionStart()
    await proc.turnStart()
    await proc.emit('tool.call', { tool: 'Read', file_path: '/secret' }, () => ({
      ref: 'r',
      result: {},
      isError: true,
      text: 'File is in a directory that is denied by your permission settings.',
    }))

    expect(rowsOf(await proc.spinner())[0]).toBe('ざわっ！')
    expect(proc.store.map.get('lastRefusal')).toMatchObject({ tool: 'Read', isError: true })
  })

  test('何も変わらないあいだは描き直しを頼まない', async () => {
    const proc = new Process('session-i')

    await proc.sessionStart()
    await proc.turnStart()
    await proc.spinner()

    const before = proc.invalidations

    await proc.advance(10_000)

    expect(proc.invalidations - before).toBe(0)
    expect(proc.timers.map(timer => timer.ms), 'タイマーは 1 秒に 1 本だけ').toEqual([1000])
  })
})
