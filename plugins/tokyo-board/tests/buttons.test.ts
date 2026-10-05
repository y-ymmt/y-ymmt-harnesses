// bun test plugins/tokyo-board/tests/buttons.test.ts
// ボードの「隠す」と、出していないあいだ帯に出る「表示」を、偽のエンジンで確かめる。
// 既定の表示時間帯は 17:00〜24:00。
import { beforeAll, expect, test } from 'bun:test'

type Node = string | Element
type Element = { type: string; props: Record<string, unknown>; children: Node[] }

beforeAll(() => {
  const flat = (children: unknown[]): Node[] =>
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

/** 偽のエンジン。時計は 18:00（表示する時間帯の中）に止めておく。 */
async function boot(hour = 18) {
  const { register } = await import('../hooks/hooks')
  const hooks: { event: string; matcher: Record<string, unknown> | null; hook: Hook }[] = []
  const store = new Map<string, unknown>()
  let invalidations = 0
  const now = new Date(2026, 9, 5, hour, 0, 0).getTime()
  let fetches = 0
  const $ = {
    clock: { now: async () => now, every: () => ({ cancel: () => undefined }) },
    http: { fetch: async () => ((fetches += 1), { ok: false, status: 503, text: '', headers: {} }) },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Link: 'Link', Button: 'Button' }),
      invalidate: () => void (invalidations += 1),
      toast: () => undefined,
    },
  }
  const on = (event: string, a: unknown, b?: unknown): void => {
    hooks.push({ event, matcher: b === undefined ? null : (a as Record<string, unknown>), hook: (b ?? a) as Hook })
  }

  ;(register as unknown as (on: unknown, options: unknown) => void)(on, { stock: false })

  const emit = async (event: string, e: Record<string, unknown>, core: (e: unknown) => unknown = () => ({})) => {
    const found = hooks.find(h => h.event === event && (h.matcher === null || Object.entries(h.matcher).every(([k, v]) => e[k] === v)))
    return found === undefined ? core(e) : found.hook($, e, async (passed: unknown) => core(passed))
  }
  const band = async (beneath: Node = { type: 'engine', props: {}, children: [] }) =>
    (await emit(
      'ui.render',
      {
        surface: 'terminal',
        component: 'AbovePrompt',
        requestId: 'band',
        props: { hasSurvey: false, isWorking: false, maxRows: 28, bodyColumns: 140, scroll: { offset: 0, bodyRows: 27 } },
      },
      () => beneath,
    )) as Node

  await emit('session.start', {}, () => ({}))
  // checkWindow は session.start から非同期で走るので、待ってから描く。
  await new Promise(resolve => setTimeout(resolve, 20))

  return { emit, band, store, invalidations: () => invalidations, fetches: () => fetches }
}

const flatten = (node: Node): Element[] => (typeof node === 'string' ? [] : [node, ...node.children.flatMap(flatten)])
const buttonsOf = (node: Node): string[] => flatten(node).filter(el => el.type === 'Button').map(el => String(el.props['key']))
const labelOf = (node: Node): string => String(flatten(node).find(el => el.type === 'Button')?.props['label'] ?? '')
/** 帯の最後の子が出し入れボタンか（ボードの有無で位置が動かない）。 */
const toggleIsLast = (node: Node): boolean => typeof node !== 'string' && (node.type === 'Box' && node.children.length > 0 ? flatten(node.children[node.children.length - 1] as Node).some(el => el.type === 'Button') : node.type === 'Box')
const textOf = (node: Node): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))

const press = (tb: Awaited<ReturnType<typeof boot>>) =>
  tb.emit('ui.press', { plugin: 'tokyo-board', element: 'board-toggle', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' })
const boardRows = (node: Node): number => flatten(node).filter(el => el.type === 'Text').length

test('時間帯の中: ボードの下に「天気・運行を隠す」が 1 つ。押すとボードが消えて「表示」に変わり、押すと戻る', async () => {
  const tb = await boot(18)
  const shown = await tb.band()

  expect(buttonsOf(shown)).toEqual(['board-toggle'])
  expect(labelOf(shown)).toBe('天気・運行を隠す')
  expect(boardRows(shown)).toBeGreaterThan(3)
  expect(toggleIsLast(shown), 'ボタンは帯のいちばん下').toBe(true)

  const before = tb.invalidations()

  await press(tb)
  expect(tb.store.get('board.override')).toBe('hide')
  expect(tb.invalidations()).toBeGreaterThan(before)

  const hidden = await tb.band()

  expect(labelOf(hidden)).toBe('天気・運行を表示')
  expect(boardRows(hidden), 'ボードの行は描かない').toBe(0)

  await press(tb)
  expect(tb.store.get('board.override')).toBe(null)
  expect(labelOf(await tb.band())).toBe('天気・運行を隠す')
})

test('ボタンは他のプラグインの描画より下に置き、ボードの有無で位置が動かない', async () => {
  const tb = await boot(18)
  const other: Element = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['touch-tree を開く'] }] }

  for (const drawn of [await tb.band(other), (await press(tb), await tb.band(other))]) {
    expect(textOf(drawn)).toContain('touch-tree を開く')
    expect(toggleIsLast(drawn)).toBe(true)
  }
})

test('時間帯の外（11 時）: 「表示」が出て、押すとその場で取りにいってボードを出し、もう一度押すと畳む', async () => {
  const tb = await boot(11)

  expect(tb.fetches(), '時間帯の外では取りにいかない').toBe(0)
  expect(labelOf(await tb.band())).toBe('天気・運行を表示')

  await press(tb)
  expect(tb.store.get('board.override')).toBe('show')
  expect(tb.fetches(), '出し始めたら取りにいく').toBeGreaterThan(0)
  expect(labelOf(await tb.band())).toBe('天気・運行を隠す')

  await press(tb)
  expect(tb.store.get('board.override'), '外で畳んだら時間帯どおりに戻すだけ').toBe(null)
  expect(labelOf(await tb.band())).toBe('天気・運行を表示')
})
