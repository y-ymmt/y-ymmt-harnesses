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

/** セッションの始め方。 */
type BootOptions = {
  /** 帯でこのプラグインより下に居る描画。 */
  below?: object
  /** 前のセッションが `$.store` に残した値。 */
  stored?: Readonly<Record<string, unknown>>
  /** 描く先。`-p`・SDK は null。 */
  surface?: 'terminal' | 'desktop' | null
  /** 始める時刻（ミリ秒）。`hour` より優先する。 */
  nowMs?: number
  /** 取りにいった URL に返す本文。null（既定）なら失敗させる。 */
  answer?: (url: string) => string | null
}

/**
 * プラグインの下（エンジン側）を用意して、セッションを始める。
 *
 * @param hour 始める時刻（2026-10-05 の何時ちょうどか）
 */
async function boot($: Engine, on: On, hour: number, options: BootOptions = {}) {
  const { below = EMPTY, stored: seed = {}, surface = 'terminal', nowMs = at(hour), answer = () => null } = options
  const clock = mock.clock(on, { now: nowMs })
  const fetched: string[] = []
  const store = new Map<string, unknown>(Object.entries(seed))

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)

    const text = answer(e.url)

    return {
      value: text === null ? { ok: false, status: 503, text: '', headers: {} } : { ok: true, status: 200, text, headers: {} },
    }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', () => below as never)

  await $.session.start({ cwd: '/work/example-app', surface, isInteractive: surface !== null })
  // 時間帯の見直しは session.start から投げっぱなしで走るので、落ち着くまで待つ。
  await clock.settle()

  /** プラグインが `$.store` に残した値。 */
  const stored = (key: string): unknown => store.get(key)

  return { clock, stored, fetched }
}

test('出し入れのボタンは、ホバーしていないときも背景色のある Box に包まれる', async ($, on) => {
  await boot($, on, 18)
  const ui = await $.ui.mount(BAND)

  const chips = (await ui.findAll({ type: 'Box' })).filter(box => box.key === `${TOGGLE}.chip`)
  expect(chips).toHaveLength(1)
  expect(chips[0]?.props['backgroundColor']).toBe('#4b5470')
})

test('時間帯の中: ボードの下に「天気・運行を隠す」が 1 つ。押すとボードが消えて「表示」に変わり、押すと戻る', async ($, on) => {
  const tb = await boot($, on, 18)
  const ui = await $.ui.mount(BAND)

  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([TOGGLE])
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')
  expect(await ui.findAll({ type: 'Text', text: /NEWS/ }), 'ボードを描いている').toHaveLength(1)

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override'), '決めた回（きょう 17:00 から）と一緒に覚える').toEqual({ value: 'hide', period: at(17) })
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')
  expect(await ui.findAll({ type: 'Text' }), 'ボードの行は描かない').toHaveLength(0)

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override')).toBe(null)
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')

  await ui.unmount()
})

test('ボタンは他のプラグインの描画より下に置き、ボードの有無で位置が動かない', async ($, on) => {
  await boot($, on, 18, { below: OTHER })
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
  expect(tb.stored('board.override'), '決めた回（きのうの 24:00 = きょう 0:00 から）と一緒に覚える').toEqual({ value: 'show', period: at(0) })
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

test('時間帯の中で隠したまま新しいセッションを開くと、隠したまま始まる（取りにもいかない）', async ($, on) => {
  const tb = await boot($, on, 20, { stored: { 'board.override': { value: 'hide', period: at(17) } } })
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')
  expect(await ui.findAll({ type: 'Text' }), 'ボードの行は描かない').toHaveLength(0)
  expect(tb.fetched, '隠しているあいだは取りにいかない').toEqual([])
  expect(tb.stored('board.override'), '覚えた値は消さない').toEqual({ value: 'hide', period: at(17) })

  // 時間帯の見直しが何度走っても、同じ回のうちは隠したまま。
  await tb.clock.advance(5 * 60_000)
  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')
  expect(tb.fetched).toEqual([])

  await ui.unmount()
})

test('時間帯の外で出したまま新しいセッションを開くと、出したまま始まる', async ($, on) => {
  const tb = await boot($, on, 15, { stored: { 'board.override': { value: 'show', period: at(0) } } })
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')
  expect(tb.fetched.length, '出しているので取りにいく').toBeGreaterThan(0)
  expect(tb.stored('board.override')).toEqual({ value: 'show', period: at(0) })

  await ui.unmount()
})

const YESTERDAY_17 = new Date(2026, 9, 4, 17, 0, 0).getTime()

for (const [name, old] of [
  ['きのうの夜に隠したもの', { value: 'hide', period: YESTERDAY_17 }],
  ['回を持たない前の版の値', 'hide'],
] as const) {
  test(`${name}は捨て、いつもの時間割で始める`, async ($, on) => {
    const tb = await boot($, on, 18, { stored: { 'board.override': old } })
    const ui = await $.ui.mount(BAND)

    expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を隠す')
    expect(tb.fetched.length, '時間帯の中なので取りにいく').toBeGreaterThan(0)
    expect(tb.stored('board.override'), '捨てた値は消す').toBe(null)

    await ui.unmount()
  })
}

test('本当の出入りではリセットする: 外で出したものは 17:00 で解く', async ($, on) => {
  const tb = await boot($, on, 0, { nowMs: at(16) + 59 * 60_000 })
  const ui = await $.ui.mount(BAND)

  await ui.press({ key: TOGGLE })
  expect(tb.stored('board.override')).toEqual({ value: 'show', period: at(0) })

  await tb.clock.set(at(17) + 30_000)
  expect(tb.stored('board.override'), '17:00 で解く').toBe(null)
  expect((await ui.find({ key: TOGGLE }))?.props['label'], '時間帯の中なので出したまま').toBe('天気・運行を隠す')

  await ui.unmount()
})

test('本当の出入りではリセットする: 中で隠したまま開いたセッションも 24:00 で解く', async ($, on) => {
  const tb = await boot($, on, 0, {
    nowMs: at(23) + 59 * 60_000,
    stored: { 'board.override': { value: 'hide', period: at(17) } },
  })
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ key: TOGGLE }))?.props['label']).toBe('天気・運行を表示')

  await tb.clock.set(at(24) + 30_000)
  expect(tb.stored('board.override'), '24:00 で解く').toBe(null)
  expect((await ui.find({ key: TOGGLE }))?.props['label'], '時間帯の外なので畳んだまま').toBe('天気・運行を表示')

  await ui.unmount()
})

for (const surface of [null, 'desktop'] as const) {
  test(`描かないセッション（${surface ?? '-p・SDK'}）では、時間帯の中でも取りにいかず、タイマーも張らない`, async ($, on) => {
    const tb = await boot($, on, 18, { surface })

    await tb.clock.advance(60 * 60_000)
    expect(tb.fetched).toEqual([])
  })
}

/** 大阪府（`270000`）に大雨警報が出ている、警報の JSON の最小の形。 */
const OSAKA_WARNING = JSON.stringify({
  areaTypes: [{ areas: [{ code: '270000', warnings: [{ code: '03', status: '発表' }] }] }],
})

test('警報と天気のリンクは warningArea の府県のページ（大阪 270000）', { options: { warningArea: '270000', placeName: '大阪' } }, async ($, on) => {
  const tb = await boot($, on, 18, { answer: url => (url.endsWith('/warning/270000.json') ? OSAKA_WARNING : null) })
  const ui = await $.ui.mount(BAND)
  const hrefs = (await ui.findAll({ type: 'Link' })).map(link => String(link.props['href']))

  expect(tb.fetched, '警報は大阪府のぶんを取りにいく').toContain('https://www.jma.go.jp/bosai/warning/data/warning/270000.json')
  expect(hrefs, '天気パネルの見出し').toContain('https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=270000')
  expect(hrefs, '▲ 行').toContain('https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=270000')
  expect(hrefs.filter(href => href.includes('130000')), '東京のページは指さない').toEqual([])

  await ui.unmount()
})
