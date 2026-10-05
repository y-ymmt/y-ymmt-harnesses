// ボードの「隠す」と、出していないあいだ帯に出る「表示」を、エンジンの上で確かめる。
// 既定の表示時間帯は 17:00〜24:00。取得はすべて失敗させる（通信はしない）。
import { expect, mock, test, tier } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

tier('user')

const PLUGIN = 'tokyo-board'
const TOGGLE = 'board-toggle'

/** 帯 1 枚ぶんの props。横 140 セル・縦 28 行の全画面表示。 */
const BAND = {
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 28,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 27 },
    view: {},
  },
}

/** 2026-10-05 の、PC の時計で `hour` 時ちょうど。 */
const at = (hour: number): number => new Date(2026, 9, 5, hour, 0, 0).getTime()

/** 何も描かない帯（エンジンの素の描画の代わり）。 */
const EMPTY = { type: 'Box', props: {}, children: [] }

/** 帯でこのプラグインより下に居る、他のプラグインの行の代わり。 */
const OTHER = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['touch-tree を開く'] }] }

/**
 * プラグインの下（エンジン側）を用意して、セッションを始める。
 *
 * @param below 帯でこのプラグインより下に居る描画
 */
async function boot($: Engine, on: On, hour: number, below: object = EMPTY) {
  const clock = mock.clock(on, { now: at(hour) })
  const fetched: string[] = []
  const store = new Map<string, unknown>()

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)

    return { value: { ok: false, status: 503, text: '', headers: {} } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', () => below as never)

  await $.session.start({ cwd: '/work/example-app', surface: 'terminal', isInteractive: true })
  // 時間帯の見直しは session.start から投げっぱなしで走るので、落ち着くまで待つ。
  await clock.settle()

  /** プラグインが `$.store` に残した値。 */
  const stored = (key: string): unknown => store.get(key)

  return { clock, stored, fetched }
}

test('時間帯の中: ボードの下に「天気・運行を隠す」が 1 つ。押すとボードが消えて「表示」に変わり、押すと戻る', async ($, on) => {
  const tb = await boot($, on, 18)
  const ui = await $.ui.mount(BAND)

  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([TOGGLE])
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')
  expect(await ui.findAll({ type: 'Text', text: /NEWS/ }), 'ボードを描いている').toHaveLength(1)

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override')).toBe('hide')
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')
  expect(await ui.findAll({ type: 'Text' }), 'ボードの行は描かない').toHaveLength(0)

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override')).toBe(null)
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')

  await ui.unmount()
})

test('ボタンは他のプラグインの描画より下に置き、ボードの有無で位置が動かない', async ($, on) => {
  await boot($, on, 18, OTHER)
  const ui = await $.ui.mount(BAND)

  /** 帯のいちばん下の子が出し入れボタンを持つか。 */
  const toggleIsLast = async (): Promise<boolean> => {
    const children = ((await ui.drawn()) as { children?: unknown[] }).children ?? []
    const last = JSON.stringify(children[children.length - 1] ?? null)

    return last.includes(`"${TOGGLE}"`)
  }

  for (const step of ['shown', 'hidden']) {
    expect(await ui.find({ type: 'Text', text: 'touch-tree を開く' }), step).toBeDefined()
    expect(await toggleIsLast(), step).toBe(true)

    await ui.press({ key: TOGGLE })
  }

  await ui.unmount()
})

test('時間帯の外（11 時）: 「表示」が出て、押すとその場で取りにいってボードを出し、もう一度押すと畳む', async ($, on) => {
  const tb = await boot($, on, 11)
  const ui = await $.ui.mount(BAND)

  expect(tb.fetched, '時間帯の外では取りにいかない').toEqual([])
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override')).toBe('show')
  expect(tb.fetched.length, '出し始めたら取りにいく').toBeGreaterThan(0)
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override'), '外で畳んだら時間帯どおりに戻すだけ').toBe(null)
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')

  await ui.unmount()
})

test('株価があった頃の設定（stock など）が残っていても読み込めて、株価には取りにいかない', { options: { stock: false, stockCode: '1234', stockRefreshSec: 60 } }, async ($, on) => {
  const tb = await boot($, on, 18)
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')
  expect(tb.fetched.length, 'ボードのぶんは取りにいく').toBeGreaterThan(0)
  expect(tb.fetched.filter(url => url.includes('finance')), '株価のページは見ない').toEqual([])

  await ui.unmount()
})
