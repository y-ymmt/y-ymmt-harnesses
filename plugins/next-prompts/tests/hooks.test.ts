/**
 * hooks.tsx を偽の `$` と `on` で動かすテスト。`bun test` で走る（claude-code/testing に依存しない）。
 *
 *   bun test plugins/next-prompts/tests/
 */
import { beforeAll, describe, expect, test } from 'bun:test'

import { BUTTON_PREFIX, CONFIRM_MS, register } from '../hooks/hooks'
import type { Message } from '../hooks/candidates'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from '../hooks/band'

type Element = { readonly type: string; readonly props: Record<string, unknown>; readonly children: readonly Node[] }
type Node = Element | string

beforeAll(() => {
  const flat = (children: readonly unknown[]): Node[] =>
    children.flatMap(child =>
      Array.isArray(child)
        ? flat(child)
        : child === null || child === undefined || child === false || child === true
          ? []
          : [typeof child === 'number' ? String(child) : (child as Node)],
    )

  ;(globalThis as Record<string, unknown>)['h'] = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
    type,
    props: props ?? {},
    children: flat(children),
  })
  ;(globalThis as Record<string, unknown>)['Fragment'] = 'Fragment'
})

type Hook = (...args: unknown[]) => unknown
type Reply = { isAnswered: true; text: string; usage: Record<string, number> } | { isAnswered: false; reason: string }

const ENGINE: Element = { type: 'engine', props: {}, children: [] }

const CONVERSATION: Message[] = [
  { role: 'user', text: 'example-app のログイン画面を直して', toolUses: [] },
  { role: 'assistant', text: '直しました。テストも追加しますか？', toolUses: [{ tool: 'Edit' }] },
]

/** 偽のエンジン。 */
function boot(options: Record<string, unknown> = {}, store: Map<string, unknown> = new Map()) {
  const hooks: { event: string; matcher: Record<string, unknown> | null; hook: Hook }[] = []
  const calls = { complete: [] as Record<string, unknown>[], fills: [] as Record<string, unknown>[], toasts: [] as string[], logs: [] as { text: string; to?: string }[], invalidations: 0 }
  const env = {
    surfaces: ['terminal'] as string[],
    messages: CONVERSATION as unknown,
    draft: '',
    now: 1_000_000,
    reply: (async () => ({ isAnswered: true, text: '["テストも追加して","コミットして","差分を見せて","別の画面も確認して"]', usage: {} })) as (
      request: Record<string, unknown>,
      options: { signal?: AbortSignal },
    ) => Promise<Reply>,
  }
  const $ = {
    session: { surfaces: async () => env.surfaces, messages: async () => env.messages },
    model: {
      complete: async (request: Record<string, unknown>, opts: { signal?: AbortSignal }) => {
        calls.complete.push(request)

        return env.reply(request, opts)
      },
    },
    prompt: {
      read: async () => ({ text: env.draft, cursor: env.draft.length }),
      fill: async (args: Record<string, unknown>) => {
        calls.fills.push(args)
        env.draft = String(args['text'])

        return { isFilled: true, text: env.draft, cursor: env.draft.length }
      },
    },
    clock: { now: async () => env.now },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      invalidate: () => void (calls.invalidations += 1),
      toast: (text: string) => void calls.toasts.push(text),
      log: (text: string, options?: { to?: string }) => void calls.logs.push({ text, to: options?.to }),
    },
  }
  const on = (event: string, a: unknown, b?: unknown): void => {
    hooks.push({ event, matcher: b === undefined ? null : (a as Record<string, unknown>), hook: (b ?? a) as Hook })
  }

  ;(register as unknown as (on: unknown, options: unknown) => void)(on, options)

  const emit = async (event: string, e: Record<string, unknown>, core: (e: unknown) => unknown = () => ({})) => {
    const found = hooks.find(h => h.event === event && (h.matcher === null || Object.entries(h.matcher).every(([k, v]) => e[k] === v)))

    return found === undefined ? core(e) : found.hook($, e, async (passed: unknown) => core(passed))
  }
  const renderEvent = (props: Record<string, unknown> = {}) => ({
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, ...props },
  })
  const band = async (beneath: Node = ENGINE, props: Record<string, unknown> = {}) => (await emit('ui.render', renderEvent(props), () => beneath)) as Node
  const startTurn = (text = '次の依頼') => emit('turn.start', { text, turnId: 't2' }, () => ({ turnId: 't2' }))
  const completeTurn = (extra: Record<string, unknown> = {}) =>
    emit('turn.complete', { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra }, () => ({ text: 'done' }))
  const press = (index: number) =>
    emit('ui.press', { plugin: 'next-prompts', element: `${BUTTON_PREFIX}${index}`, component: 'AbovePrompt', requestId: 'band', surface: 'terminal' }, () => ({ element: `${BUTTON_PREFIX}${index}` }))
  const hook = (event: string) => hooks.find(h => h.event === event)?.hook as Hook

  return { $, env, calls, emit, band, startTurn, completeTurn, press, hook, renderEvent, store }
}

/** 投げっぱなしの候補づくりが終わるまで待つ。 */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const flatten = (node: Node): Element[] => (typeof node === 'string' ? [] : [node, ...node.children.flatMap(flatten)])
const buttons = (node: Node) => flatten(node).filter(el => el.type === 'Button')
const labels = (node: Node) => buttons(node).map(el => String(el.props['label']))
const textOf = (node: Node): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
/** 候補のボタンだけ（切り替えボタンなど他のプラグインのものを除く）。 */
const candidatesOf = (node: Node) => buttons(node).filter(el => String(el.props['key']).startsWith(BUTTON_PREFIX))

describe('候補づくり', () => {
  test('メインのターンが終わると haiku に会話を渡して候補を作り、帯に並べる', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()

    expect(tb.calls.complete.length).toBe(1)
    expect(tb.calls.complete[0]?.['model']).toBe('haiku')
    expect(tb.calls.complete[0]?.['effort'], '軽い仕事なので浅く考えさせる').toBe('low')
    expect(tb.calls.logs.map(l => l.to), 'かかった時間はデバッグログだけに出す').toEqual(['debug'])
    expect(tb.calls.logs[0]?.text).toMatch(/^haiku effort=low \d+ms in=.* out=.* answered/)
    expect(String(tb.calls.complete[0]?.['prompt'])).toContain('example-app のログイン画面を直して')

    const drawn = await tb.band()

    expect(textOf(drawn)).toContain('次の一手:')
    expect(labels(drawn)).toEqual(['テストも追加して', 'コミットして', '差分を見せて', '別の画面も確認して'])
    expect(buttons(drawn).map(b => b.props['key'])).toEqual([0, 1, 2, 3].map(i => `${BUTTON_PREFIX}${i}`))
  })

  test('作っている間は「候補を考え中…」を薄字で出す', async () => {
    const tb = boot()
    let finish: (reply: Reply) => void = () => undefined

    tb.env.reply = () => new Promise<Reply>(resolve => (finish = resolve))
    await tb.completeTurn()
    await settle()

    const thinking = await tb.band()

    expect(textOf(thinking)).toContain('候補を考え中…')
    expect(flatten(thinking).find(el => textOf(el) === '候補を考え中…' && el.type === 'Text')?.props['dimColor']).toBe(true)

    finish({ isAnswered: true, text: '["a"]', usage: {} })
    await settle()
    expect(textOf(await tb.band())).not.toContain('考え中')
  })

  test('サブエージェントのターンや中断では作らない', async () => {
    const tb = boot()

    await tb.completeTurn({ agentId: 'agent-1' })
    await tb.completeTurn({ reason: 'aborted', isAborted: true })
    await settle()

    expect(tb.calls.complete.length).toBe(0)
  })

  test('帯を描く端末が無い（-p）なら作らない', async () => {
    const tb = boot()

    tb.env.surfaces = []
    await tb.completeTurn()
    await settle()

    expect(tb.calls.complete.length).toBe(0)
  })

  test('enabled=false なら作らず何も描かない', async () => {
    const tb = boot({ enabled: false })

    await tb.completeTurn()
    await settle()

    expect(tb.calls.complete.length).toBe(0)
    expect(candidatesOf(await tb.band()).length).toBe(0)
  })

  test('count と model の設定が効く（count は 3〜6 に収める）', async () => {
    const tb = boot({ count: 9, model: 'sonnet' })

    tb.env.reply = async () => ({ isAnswered: true, text: JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8']), usage: {} })
    await tb.completeTurn()
    await settle()

    expect(tb.calls.complete[0]?.['model']).toBe('sonnet')
    expect(labels(await tb.band())).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  test('直前の依頼と同じ候補は出さない', async () => {
    const tb = boot()

    tb.env.reply = async () => ({ isAnswered: true, text: '["example-app のログイン画面を直して","コミットして"]', usage: {} })
    await tb.completeTurn()
    await settle()

    expect(labels(await tb.band())).toEqual(['コミットして'])
  })
})

describe('失敗したとき', () => {
  for (const [name, reply] of [
    ['API エラー', async (): Promise<Reply> => ({ isAnswered: false, reason: 'api-error' })],
    ['壊れた JSON', async (): Promise<Reply> => ({ isAnswered: true, text: '["途中', usage: {} })],
    ['例外', async (): Promise<Reply> => Promise.reject(new Error('blocked model'))],
  ] as const) {
    test(`${name}: 何も出さず、例外も外へ出さない`, async () => {
      const tb = boot()

      tb.env.reply = reply
      await expect(tb.completeTurn()).resolves.toEqual({ text: 'done' })
      await settle()

      expect(candidatesOf(await tb.band()).length).toBe(0)
    })
  }

  test('会話が読めない（messages が例外）ときも何も出さない', async () => {
    const tb = boot()

    tb.$.session.messages = async () => Promise.reject(new Error('no session'))
    await tb.completeTurn()
    await settle()

    expect(candidatesOf(await tb.band()).length).toBe(0)
  })
})

describe('消すとき', () => {
  test('次のターンが始まったら候補を消す', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()
    expect(labels(await tb.band()).length).toBe(4)

    await tb.startTurn()
    expect(candidatesOf(await tb.band()).length).toBe(0)
  })

  test('作っている途中で次のターンが始まったら、止めて結果を捨てる', async () => {
    const tb = boot()
    let finish: (reply: Reply) => void = () => undefined
    let signal: AbortSignal | undefined

    tb.env.reply = (_request, opts) => ((signal = opts.signal), new Promise<Reply>(resolve => (finish = resolve)))
    await tb.completeTurn()
    await settle()
    await tb.startTurn()

    expect(signal?.aborted).toBe(true)

    finish({ isAnswered: true, text: '["遅れて来た候補"]', usage: {} })
    await settle()
    expect(candidatesOf(await tb.band()).length).toBe(0)
  })

  test('作業中は候補を出さず行だけ残す。アンケート中・端末以外は描かない', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()

    const working = await tb.band(ENGINE, { isWorking: true })

    expect(candidatesOf(working).length, '作業中は候補を出さない').toBe(0)
    expect(textOf(working), '行は残して位置を保つ').toContain('（作業中）')
    expect(await tb.band(ENGINE, { hasSurvey: true })).toBe(ENGINE)
    expect(await tb.emit('ui.render', { ...tb.renderEvent(), surface: 'desktop' }, () => ENGINE)).toBe(ENGINE)
  })
})

describe('標準の提案', () => {
  test('先頭に足して重複を除き、標準の提案そのものは消さない（next に渡す）', async () => {
    const tb = boot()
    let passed: unknown = null

    await tb.completeTurn()
    const shown = await tb.emit('prompt.suggest', { text: 'コミットして', origin: { kind: 'suggestion' } }, e => ((passed = e), { isShown: true }))
    await settle()

    expect(shown).toEqual({ isShown: true })
    expect((passed as { text: string }).text).toBe('コミットして')
    expect(labels(await tb.band())).toEqual(['コミットして', 'テストも追加して', '差分を見せて', '別の画面も確認して'])
  })

  test('他のプラグインの提案は足さない', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()
    await tb.emit('prompt.suggest', { text: '宣伝', origin: { kind: 'plugin', name: 'other' } }, () => ({ isShown: true }))

    expect(labels(await tb.band())).not.toContain('宣伝')
  })
})

describe('押したとき', () => {
  test('ラベルは切っても、入力欄には全文を replace で入れる（送信はしない）', async () => {
    const tb = boot()
    const long = 'ログイン画面のバリデーションをすべて見直して、エラーメッセージも日本語に揃えて'

    tb.env.reply = async () => ({ isAnswered: true, text: JSON.stringify([long, 'コミットして']), usage: {} })
    await tb.completeTurn()
    await settle()

    const drawn = await tb.band(ENGINE, { bodyColumns: 50 })

    expect(labels(drawn)[0]?.endsWith('…')).toBe(true)

    await tb.press(0)
    expect(tb.calls.fills).toEqual([{ text: long, mode: 'replace' }])
  })

  test('候補を入れたまま別の候補を押すと、そのまま差し替える', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()
    await tb.band()
    await tb.press(0)
    await tb.press(1)

    expect(tb.calls.fills.map(f => f['text'])).toEqual(['テストも追加して', 'コミットして'])
    expect(tb.calls.toasts).toEqual([])
  })

  test('自分で打ちかけた文があれば 1 回目は知らせるだけ、同じボタンの 2 回目で置き換える', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()
    await tb.band()
    tb.env.draft = '自分で打ちかけた文'

    await tb.press(1)
    expect(tb.calls.fills).toEqual([])
    expect(tb.calls.toasts.length).toBe(1)

    tb.env.now += 1_000
    await tb.press(1)
    expect(tb.calls.fills).toEqual([{ text: 'コミットして', mode: 'replace' }])
  })

  test('打ちかけの確認は時間が過ぎたら、もう一度 1 回目から', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()
    await tb.band()
    tb.env.draft = '自分で打ちかけた文'

    await tb.press(0)
    tb.env.now += CONFIRM_MS + 1
    await tb.press(0)
    expect(tb.calls.fills).toEqual([])
    expect(tb.calls.toasts.length).toBe(2)
  })

  test('他のプラグインのボタンには反応せず、next に渡す', async () => {
    const tb = boot()
    let reached = false

    await tb.completeTurn()
    await settle()
    await tb.band()
    await tb.emit('ui.press', { plugin: 'touch-tree', element: 'touch-tree-toggle', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' }, () => ((reached = true), {}))

    expect(reached).toBe(true)
    expect(tb.calls.fills).toEqual([])
  })
})

describe('再開したセッション', () => {
  test('作った候補を保存し、同じ会話を再開したら最初の描画で出し直す', async () => {
    const store = new Map<string, unknown>()
    const first = boot({}, store)

    await first.completeTurn()
    await settle()
    expect(candidatesOf(await first.band()).length).toBe(4)

    // claude -c / -r: 新しいプロセスで、同じ会話から始まる
    const resumed = boot({}, store)

    expect(candidatesOf(await resumed.band()).length, '最初の描画では読み戻しにいくだけ').toBe(0)
    await settle()
    expect(candidatesOf(await resumed.band()).map(b => b.props['label'])).toEqual(['テストも追加して', 'コミットして', '差分を見せて', '別の画面も確認して'])
    expect(resumed.calls.complete, 'モデルは呼ばない').toEqual([])
  })

  test('会話が先に進んでいたら古い候補は出さない', async () => {
    const store = new Map<string, unknown>()
    const first = boot({}, store)

    await first.completeTurn()
    await settle()

    const resumed = boot({}, store)

    resumed.env.messages = [...CONVERSATION, { role: 'user', text: 'お願い' }, { role: 'assistant', text: '追加しました。' }]
    await resumed.band()
    await settle()
    expect(candidatesOf(await resumed.band()).length).toBe(0)
  })
})

describe('帯の共存', () => {
  /** 帯を使う他の 2 プラグインの組み方（先に next を呼び、band.ts の枠に入れて積み直す）を写したもの。 */
  type RenderHook = (e: unknown, next: (e: unknown) => Promise<Node>) => Promise<Node>

  const stack = (beneath: Node, mine: Element[]): Element => ({ type: 'Box', props: { key: BAND_STACK, flexDirection: 'column' }, children: stackBand(beneath, mine) as Node[] })
  const toggle = (key: string, order?: number): Element => ({
    type: 'Box',
    props: order === undefined ? { flexDirection: 'row' } : { key: slotKey(order, key), flexDirection: 'row' },
    children: [{ type: 'Button', props: { key, label: key }, children: [] }],
  })
  const tokyoBoard: RenderHook = async (e, next) => {
    const board: Element = { type: 'Box', props: { key: slotKey(BAND_ORDER.board, 'tokyo-board') }, children: [{ type: 'Text', props: {}, children: ['天気・運行'] }] }

    return stack(await next(e), [board, toggle('board-toggle', BAND_ORDER.boardToggle)])
  }
  const touchTree: RenderHook = async (e, next) => stack(await next(e), [toggle('touch-tree-toggle', BAND_ORDER.touchTreeToggle)])
  /** この約束を知らない他所のプラグイン。受け取った描画の下に自分の行を足すだけ。 */
  const stranger: RenderHook = async (e, next) => {
    const beneath = await next(e)
    const row = toggle('stranger')

    return beneath === ENGINE ? row : { type: 'Box', props: { flexDirection: 'column' }, children: [beneath, row] }
  }

  const permutations = <T,>(items: T[]): T[][] =>
    items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]))
  /** 上から順に、帯の各行が何か（ボード / 各ボタン / 候補の行）。 */
  const rowsOf = (drawn: Node): string[] =>
    typeof drawn === 'string'
      ? []
      : drawn.children.map(child => {
          if (textOf(child).includes('天気・運行')) return 'board'
          const keys = buttons(child).map(b => String(b.props['key']))

          return keys.some(k => k.startsWith(BUTTON_PREFIX)) ? 'next-prompts' : keys.join(',')
        })

  test('どの読み込み順でも、上からボード → touch-tree → 天気・運行 → 候補の行（入力欄のすぐ上）に並ぶ', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()

    const mine: RenderHook = (e, next) => tb.hook('ui.render')(tb.$, e, next) as Promise<Node>
    const orders = permutations([
      ['next-prompts', mine],
      ['tokyo-board', tokyoBoard],
      ['touch-tree', touchTree],
    ] as [string, RenderHook][])

    for (const order of orders) {
      const chain = order.reduceRight<(e: unknown) => Promise<Node>>((next, [, hook]) => e => hook(e, next), async () => ENGINE)
      const drawn = await chain(tb.renderEvent())
      const name = order.map(([n]) => n).join(' > ')

      expect(rowsOf(drawn), name).toEqual(['board', 'touch-tree-toggle', 'board-toggle', 'next-prompts'])
      expect(candidatesOf(drawn).length, name).toBe(4)
    }
  })

  test('約束を知らないプラグインが混ざっても誰の行も消えない（知らない側の行は帯のいちばん上か、外側ならその下）', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()

    const mine: RenderHook = (e, next) => tb.hook('ui.render')(tb.$, e, next) as Promise<Node>

    for (const order of permutations([mine, tokyoBoard, touchTree, stranger])) {
      const chain = order.reduceRight<(e: unknown) => Promise<Node>>((next, hook) => e => hook(e, next), async () => ENGINE)
      const keys = buttons(await chain(tb.renderEvent())).map(b => String(b.props['key']))

      for (const key of ['stranger', 'board-toggle', 'touch-tree-toggle']) expect(keys).toContain(key)
      expect(keys.filter(k => k.startsWith(BUTTON_PREFIX)).length).toBe(4)
    }
  })

  test('描く木は端末の要素と props だけで組み、1 つの Text が 1 万文字を超えない', async () => {
    const tb = boot()
    const allowed: Record<string, string[]> = {
      Box: ['flexDirection', 'flexWrap', 'columnGap', 'key'],
      Text: ['dimColor'],
      Button: ['key', 'label', 'onPress'],
    }

    tb.env.reply = async () => ({ isAnswered: true, text: JSON.stringify(['あ'.repeat(150), 'b', 'c', 'd']), usage: {} })
    await tb.completeTurn()
    await settle()

    for (const columns of [20, 80, 200]) {
      for (const el of flatten(await tb.band(ENGINE, { bodyColumns: columns }))) {
        expect(Object.keys(allowed)).toContain(el.type)
        for (const prop of Object.keys(el.props)) expect(allowed[el.type]).toContain(prop)
        if (el.type === 'Text') expect(textOf(el).length).toBeLessThan(10_000)
        if (el.type === 'Button') expect(typeof el.props['label']).toBe('string')
      }
    }
  })

  test('下に誰も居なければ候補の行だけを返す（engine の描画は置き換える）', async () => {
    const tb = boot()

    await tb.completeTurn()
    await settle()

    const drawn = (await tb.band()) as Element

    expect(drawn.props['key']).toBe(BAND_STACK)
    expect(drawn.children.length).toBe(1)
    expect((drawn.children[0] as Element).props['flexWrap']).toBe('wrap')
  })

  test('候補が無いときも行は残し（—）、下の描画はその上にそのまま並べる', async () => {
    const tb = boot()
    const other = toggle('touch-tree-toggle', BAND_ORDER.touchTreeToggle)
    const drawn = await tb.band(other)

    expect(candidatesOf(drawn).length).toBe(0)
    expect(textOf(drawn)).toContain('—')
    expect(typeof drawn !== 'string' && drawn.children[0]).toBe(other)
  })
})
