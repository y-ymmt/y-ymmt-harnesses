// bun test plugins/tokyo-board/tests/buttons.test.ts
// ボードの「隠す」と、隠しているあいだ帯に出る「表示」を、偽のエンジンで確かめる。
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
async function boot() {
  const { register } = await import('../hooks/hooks')
  const hooks: { event: string; matcher: Record<string, unknown> | null; hook: Hook }[] = []
  const store = new Map<string, unknown>()
  let invalidations = 0
  const now = new Date(2026, 9, 5, 18, 0, 0).getTime()
  const $ = {
    clock: { now: async () => now, every: () => ({ cancel: () => undefined }) },
    http: { fetch: async () => ({ ok: false, status: 503, text: '', headers: {} }) },
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

  return { emit, band, store, invalidations: () => invalidations }
}

const flatten = (node: Node): Element[] => (typeof node === 'string' ? [] : [node, ...node.children.flatMap(flatten)])
const buttonsOf = (node: Node): string[] => flatten(node).filter(el => el.type === 'Button').map(el => String(el.props['key']))
const textOf = (node: Node): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))

test('時間帯の中ではボードに「隠す」が出て、押すと「表示」の 1 行だけになり、押すと戻る', async () => {
  const tb = await boot()

  expect(buttonsOf(await tb.band())).toEqual(['board-hide'])

  const before = tb.invalidations()

  await tb.emit('ui.press', { plugin: 'tokyo-board', element: 'board-hide', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' })
  expect(tb.store.get('board.hidden')).toBe(true)
  expect(tb.invalidations()).toBeGreaterThan(before)

  const hidden = await tb.band()

  expect(buttonsOf(hidden)).toEqual(['board-show'])
  expect(flatten(hidden).filter(el => el.type === 'Text').length, 'ボードの行は描かない').toBe(0)

  await tb.emit('ui.press', { plugin: 'tokyo-board', element: 'board-show', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' })
  expect(tb.store.get('board.hidden')).toBe(false)
  expect(buttonsOf(await tb.band())).toEqual(['board-hide'])
})

test('隠しているあいだも、帯の下に居る他のプラグインの描画は消さない', async () => {
  const tb = await boot()
  const other: Element = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['touch-tree を開く'] }] }

  await tb.emit('ui.press', { plugin: 'tokyo-board', element: 'board-hide', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' })

  const drawn = await tb.band(other)

  expect(textOf(drawn)).toContain('touch-tree を開く')
  expect(buttonsOf(drawn)).toEqual(['board-show'])
})
