import { isWithin, windowOf } from './window'
import type { ShowWindow } from './window'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  BOARD_BACK,
  BOARD_FRAME,
  BOARD_ROWS,
  CHART_COLUMNS,
  NEWS_HEAD,
  NEWS_LABEL,
  NEWS_TEXT,
  NUMBER_FACE,
  PANEL_ROWS,
  PANEL_WIDTH,
  newsWindowOf,
  stockHeadOf,
  stockPanel,
  transitBoard,
  weatherPanel,
} from './board'
import type { Line, StockChart } from './board'
import {
  PERIOD_LABEL,
  historyUrlsOf,
  intradaySlots,
  jstDayOf,
  nextPeriod,
  parseHistory,
  periodOf,
  resample,
  shortDateOf,
} from './chart'
import type { HistoryPoint, Period, Tick } from './chart'
import {
  AREA_URL,
  USER_AGENT,
  changedLines,
  diainfoUrl,
  lineIdOf,
  linesOf,
  parseAreaLines,
  parseStatus,
} from './transit'
import type { LineStatus } from './transit'
import {
  FORECAST_URL,
  LATEST_TIME_URL,
  NO_FORECAST,
  amedasUrl,
  dailyOf,
  jmaForecastUrl,
  latestOf,
  openMeteoUrl,
  popOf,
  skyOf,
} from './weather'
import type { Amedas, Forecast, Sky } from './weather'
import {
  NO_ALERTS,
  QUAKE_URL,
  WARNING_PAGE_URL,
  hasAlerts,
  newAlertsOf,
  parseWarnings,
  quakeOf,
  warningUrl,
} from './alerts'
import type { Alerts } from './alerts'
import {
  DEFAULT_NEWS_FEEDS,
  NEWS_URL_FALLBACK,
  NO_NEWS,
  interleave,
  marqueeRunsOf,
  matchesKeywords,
  newsLineOf,
  parseFeed,
  parseFeedSpecs,
} from './news'
import type { FeedSpec, NewsItem, NewsLine } from './news'
import { isMarketOpen, parseQuote, quoteUrl } from './stock'
import type { Quote } from './stock'

/** 路線一覧を覚えておく時間（ミリ秒）。1 日。 */
const AREA_TTL_MS = 24 * 60 * 60 * 1000

/** 警報・地震を見にいく間隔（ミリ秒）。 */
const ALERT_MS = 5 * 60 * 1000

/** ニュースを取りにいく間隔（ミリ秒）。 */
const NEWS_MS = 10 * 60 * 1000

/** ボードの左右の余白（セル）。 */
const GUTTER = 1

/** 掲示板をこれ以上広くはしない。 */
const BOARD_MAX = 72

/** 掲示板をこれより狭くはしない。 */
const BOARD_MIN = 24

/** 株価パネルの見出しに置くボタンの名札。 */
const STOCK_BUTTON = 'stock-face'

/**
 * 覚えておいたものを戻す。
 *
 * 面（どのグラフを出していたか）、期間ごとの時系列、当日の記録の 3 つ。
 * 日付が変わっていれば当日の記録は捨てる。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function restore($: EngineInterface, board: Board): Promise<void> {
  board.today = jstDayOf(await $.clock.now())
  board.period = periodOf(await $.store.get('stock.period'))

  const charts = await $.store.get('stock.charts')

  if (typeof charts === 'object' && charts !== null) {
    board.charts = charts as Record<string, { on: string; points: HistoryPoint[] }>
  }

  const ticks = await $.store.get('stock.ticks')
  const kept = ticks as { on?: unknown; list?: unknown } | null

  if (typeof kept?.on === 'string' && Array.isArray(kept.list) && kept.on === board.today) {
    board.ticks = { on: kept.on, list: kept.list as Tick[] }
  }

  await ensureChart($, board)
  await repaint($, board)
}

/** 時間帯の出入りを見直す間隔（ミリ秒）。 */
const WINDOW_CHECK_MS = 30_000

/** このセッションぶんの状態。 */
type Board = {
  /** ボードを出すか（設定 `enabled`）。 */
  readonly isShown: boolean
  /** 出す時間帯（設定 `showFrom` / `showUntil`）。null はいつでも。 */
  readonly window: ShowWindow
  /** 今が時間帯の中か。`checkWindow` が 30 秒ごとに見直す。 */
  isOpen: boolean
  /** 見たい路線（設定 `lines`）。 */
  readonly wanted: readonly string[]
  /** 取りにいく間隔（ミリ秒）。 */
  readonly trainMs: number
  readonly weatherMs: number
  readonly stockMs: number
  /** マーキーが 1 セル進むまで（ミリ秒）。 */
  readonly marqueeMs: number
  /** アメダスの地点と、天気アイコンを引く座標。 */
  readonly point: string
  readonly latitude: number
  readonly longitude: number
  /** 警報・地震を見る区域（東京地方は `130010`）と、地震を出す時間の窓（分）。 */
  readonly warningArea: string
  /** 見出しと震度の前に出す地名（設定 `placeName`）。 */
  readonly placeName: string
  readonly quakeWindowMin: number
  readonly showAlerts: boolean
  /** ニュース。 */
  readonly showNews: boolean
  readonly feeds: readonly FeedSpec[]
  /** 配信元 1 つあたりの見出しの本数。 */
  readonly newsCount: number
  /** 株価。 */
  readonly showStock: boolean
  readonly stockCode: string
  /** いま出している面（数字の板かグラフ）。ボタンで変わり、`$.store` に残る。 */
  period: Period
  /** 期間ごとの時系列（日付が変わるまで使い回す）。 */
  charts: Record<string, { on: string; points: HistoryPoint[] }>
  /** 当日の記録（3 分ごとの株価取得を貯めたもの）。 */
  ticks: { on: string; list: Tick[] }
  /** 時系列を取りにいっている最中か（二重に取らない）。 */
  chartBusy: boolean
  /** 日本時間のきょう（`YYYY-MM-DD`）。 */
  today: string
  /** 走っているターンがあるか。ある間は取りにいかない。 */
  isWorking: boolean
  /** 実況。まだ取れていなければ null。 */
  weather: Amedas | null
  /** 空模様。 */
  sky: Sky
  /** きょうの見通し。 */
  forecast: Forecast
  /** 運行状況。 */
  transit: LineStatus[]
  /** 警報・注意報と地震。 */
  alerts: Alerts
  /** 流すニュースの見出しと、どこが誰の見出しか。 */
  news: NewsLine
  /** 配信元ごとの見出し（1 本落ちても他は残す）。 */
  newsByFeed: Record<string, NewsItem[]>
  /** 株価の板。 */
  quote: Quote | null
  /** 路線名 → id。1 日覚えておく。 */
  area: Record<string, string>
  areaAtMs: number
  /** それぞれ、取りにいけなかったか（薄字で出す）。 */
  weatherStale: boolean
  transitStale: boolean
  stockStale: boolean
  /** 天気を最後に取りにいった時刻（`HH:MM`）。運行の時刻は各路線が持つ。 */
  weatherAt: string
  /** マーキーを進めた回数。 */
  step: number
  /** 直前に描いた姿。変わったときだけ描き直す。 */
  shown: string
  /** セッションで回しているタイマー。 */
  readonly timers: Timer[]
}

/** 設定値を boolean として読む。 */
function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 設定値を範囲内の数として読む。 */
function numberOf(value: unknown, fallback: number, low: number, high: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(parsed) ? Math.max(low, Math.min(parsed, high)) : fallback
}

/** 設定値を文字列として読む。 */
function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** `HH:MM`。 */
function clockOf(nowMs: number): string {
  const at = new Date(nowMs)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 区域コードから府県コード（`130010` → `130000`）。 */
function officeOf(area: string): string {
  return `${area.slice(0, 2)}0000`
}

/** ブラウザの名乗りを付けて取りにいく。取れなければ null。 */
async function getText($: EngineInterface, url: string): Promise<string | null> {
  try {
    const answer = await $.http.fetch(url, { headers: { 'User-Agent': USER_AGENT } })

    return answer.ok ? answer.text : null
  } catch {
    return null
  }
}

/**
 * 天気を取りにいく。アメダスの実況、アイコン用の天気コード、きょうの見通し。
 *
 * ターン中は何もしない（モデルの応答を待たせないため）。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchWeather($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || board.isWorking) {
    return
  }

  const nowMs = await $.clock.now()

  board.weatherAt = clockOf(nowMs)

  const iso = (await getText($, LATEST_TIME_URL))?.trim()
  const table = iso === undefined ? null : await getText($, amedasUrl(board.point, iso))

  if (table !== null) {
    try {
      const latest = latestOf(JSON.parse(table) as Record<string, unknown>)

      if (latest !== null) {
        board.weather = latest
        board.weatherStale = false
      }
    } catch {
      board.weatherStale = true
    }
  } else {
    board.weatherStale = true
  }

  // Open-Meteo は 1 回で「いまの天気コード」と「きょうの最高最低・日の入り」を返す。
  const forecast = await getText($, openMeteoUrl(board.latitude, board.longitude))

  if (forecast !== null) {
    try {
      const parsed = JSON.parse(forecast) as { current?: { weather_code?: number } }
      const code = parsed.current?.weather_code

      if (typeof code === 'number') {
        board.sky = skyOf(code)
      }

      board.forecast = { ...dailyOf(parsed) }
    } catch {
      // アイコンも見通しも前のままでよい。
    }
  }

  // 降水確率は気象庁のほうが細かい（6 時間ごと）。取れたらそちらで上書きする。
  const jma = await getText($, jmaForecastUrl(officeOf(board.warningArea)))

  if (jma !== null) {
    try {
      const pop = popOf(JSON.parse(jma), board.warningArea, nowMs)

      if (pop !== null) {
        board.forecast = { ...board.forecast, pop }
      }
    } catch {
      // Open-Meteo のぶんが残る。
    }
  }

  await repaint($, board)
}

/**
 * 警報・注意報と地震を見にいく。
 *
 * ふだんは何も出ない。警報・特別警報が新しく出たときと、条件に当たる地震が
 * 来たときだけトーストで知らせる（注意報は毎日のように出るので黙って出す）。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchAlerts($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || !board.showAlerts || board.isWorking) {
    return
  }

  const nowMs = await $.clock.now()
  const warningText = await getText($, warningUrl(officeOf(board.warningArea)))
  const quakeText = await getText($, QUAKE_URL)
  const before = board.alerts
  let warnings = before.warnings
  let quake = before.quake

  if (warningText !== null) {
    try {
      warnings = parseWarnings(JSON.parse(warningText), board.warningArea)
    } catch {
      // 前回の姿を残す。
    }
  }

  if (quakeText !== null) {
    try {
      quake = quakeOf(JSON.parse(quakeText), {
        nowMs,
        windowMin: board.quakeWindowMin,
        pref: board.warningArea.slice(0, 2),
      })
    } catch {
      // 前回の姿を残す。
    }
  }

  // 窓から出た地震はひとりでに消える。
  if (quake !== null && nowMs - quake.atMs > board.quakeWindowMin * 60_000) {
    quake = null
  }

  const after: Alerts = { warnings, quake }

  for (const note of newAlertsOf(before, after)) {
    $.ui.toast(note, { timeoutMs: 10000 })
  }

  board.alerts = after

  await repaint($, board)
}

/**
 * ニュースの見出しを取りにいく。
 *
 * 配信元ごとに独立して取り、落ちた配信元は前回の見出しをそのまま残す
 * （1 本落ちても残りは出る）。NHK の新しい配信元が駄目なときだけ昔の配信元を試す。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchNews($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || !board.showNews || board.feeds.length === 0) {
    return
  }

  if (board.isWorking) {
    return
  }

  for (const feed of board.feeds) {
    const primary = await getText($, feed.url)
    const xml =
      primary ?? (feed.url.includes('news.web.nhk') ? await getText($, NEWS_URL_FALLBACK) : null)

    if (xml === null) {
      continue
    }

    const parsed = parseFeed(xml)

    board.newsByFeed[feed.url] = parsed.items
      .filter(item => matchesKeywords(item.title, feed.keywords))
      .map(item => ({ ...item, label: feed.label }))
  }

  board.news = newsLineOf(
    interleave(
      board.feeds.map(feed => board.newsByFeed[feed.url] ?? []),
      board.newsCount,
    ),
  )

  await repaint($, board)
}

/**
 * 株価を取りにいく。
 *
 * 場が開いている平日の 8:55〜15:35 だけ繰り返し取り、それ以外は 1 度取った
 * 終値をそのまま出す（休みの日に 3 分ごと同じ値を取りにいかないため）。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchStock($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || !board.showStock || board.isWorking) {
    return
  }

  const nowMs = await $.clock.now()

  if (board.quote !== null && !isMarketOpen(nowMs)) {
    return
  }

  const html = await getText($, quoteUrl(board.stockCode))
  const quote = html === null ? null : parseQuote(html)

  if (quote === null) {
    board.stockStale = true
  } else {
    board.quote = quote
    board.stockStale = false

    await recordTick($, board, nowMs, quote.at, quote.price)
  }

  await repaint($, board)
}

/**
 * 当日の値動きを 1 点ぶん覚える。
 *
 * 分足を無料で配っているところが見当たらないので、3 分ごとの株価取得を
 * そのまま「1 日」のグラフの点にする。日付が変わったら前の日のぶんは捨てる。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 * @param nowMs いまの時刻
 * @param at 板の時刻（`HH:MM`）
 * @param price 現在値
 */
async function recordTick(
  $: EngineInterface,
  board: Board,
  nowMs: number,
  at: string,
  price: number | null,
): Promise<void> {
  const today = jstDayOf(nowMs)

  board.today = today

  if (price === null || !/^\d{1,2}:\d{2}$/.test(at) || !isMarketOpen(nowMs)) {
    return
  }

  if (board.ticks.on !== today) {
    board.ticks = { on: today, list: [] }
  }

  const last = board.ticks.list[board.ticks.list.length - 1]

  if (last !== undefined && last.at === at) {
    return
  }

  board.ticks.list = [...board.ticks.list, { at, price }].slice(-400)

  await $.store.set('stock.ticks', board.ticks)
}

/**
 * いま出している面の時系列を、まだ無ければ取りにいく。
 *
 * 面を初めて開いたときに 1 回だけ取り、あとは日付が変わるまで使い回す。
 * ページを順に取り、途中で駄目になったら取れたぶんで描く。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function ensureChart($: EngineInterface, board: Board): Promise<void> {
  const period = board.period

  if (!board.isShown || !board.isOpen || !board.showStock || board.isWorking || board.chartBusy) {
    return
  }

  if (period === 'number' || period === 'day') {
    return
  }

  const nowMs = await $.clock.now()
  const today = jstDayOf(nowMs)

  board.today = today

  if (board.charts[period]?.on === today) {
    return
  }

  board.chartBusy = true

  const found: HistoryPoint[] = []

  for (const url of historyUrlsOf(board.stockCode, period, nowMs)) {
    const html = await getText($, url)

    if (html === null) {
      break
    }

    found.push(...parseHistory(html))
  }

  board.chartBusy = false

  if (found.length === 0) {
    return
  }

  const merged = [...new Map(found.map(point => [point.date, point])).values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  )

  board.charts = { ...board.charts, [period]: { on: today, points: merged } }

  await $.store.set('stock.charts', board.charts)
  await repaint($, board)
}

/**
 * いま出す面を組み立てる。
 *
 * 最新の点は現在値にする。日足の最終日がきょうなら置き換え、まだ前の営業日の
 * ままなら 1 点足す。
 *
 * @param board このセッションの状態
 */
function chartOf(board: Board): StockChart {
  const width = CHART_COLUMNS * 2

  if (board.period === 'number') {
    return NUMBER_FACE
  }

  if (board.period === 'day') {
    const list = board.ticks.on === board.today ? board.ticks.list : []

    if (list.length < 2) {
      return { period: 'day', slots: [], from: '', to: '', note: '3分ごとに記録します' }
    }

    return {
      period: 'day',
      slots: intradaySlots(list, width),
      from: '09:00',
      to: '15:30',
      note: '',
    }
  }

  const cached = board.charts[board.period]

  if (cached === undefined || cached.points.length === 0) {
    return { period: board.period, slots: [], from: '', to: '', note: '取得中…' }
  }

  const closes = cached.points.map(point => point.close)
  const price = board.quote?.price ?? null
  const lastDate = cached.points[cached.points.length - 1]?.date ?? ''

  if (price !== null) {
    if (lastDate === board.today) {
      closes[closes.length - 1] = price
    } else {
      closes.push(price)
    }
  }

  return {
    period: board.period,
    slots: resample(closes, width),
    from: shortDateOf(cached.points[0]?.date ?? ''),
    to: lastDate === board.today ? shortDateOf(lastDate) : shortDateOf(board.today),
    note: '',
  }
}

/**
 * 運行情報を取りにいく。路線名 → id は 1 日覚えておく。
 *
 * 平常 ↔ 異常が入れ替わったらトーストで知らせる（ターン中でも鳴る）。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchTransit($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || board.isWorking) {
    return
  }

  const nowMs = await $.clock.now()

  if (nowMs - board.areaAtMs > AREA_TTL_MS) {
    const area = await getText($, AREA_URL)

    if (area !== null) {
      board.area = parseAreaLines(area)
      board.areaAtMs = nowMs
    }
  }

  const found: LineStatus[] = []
  let failed = false

  for (const name of board.wanted) {
    const id = lineIdOf(name, board.area)

    if (id === null) {
      continue
    }

    const page = await getText($, diainfoUrl(id))
    const status = page === null ? null : parseStatus(page)

    if (status === null) {
      const before = board.transit.find(line => line.name === name)

      if (before !== undefined) {
        found.push(before)
      }

      failed = true

      continue
    }

    found.push({ name, id, isNormal: status.isNormal, text: status.text, at: clockOf(nowMs) })
  }

  board.transitStale = failed

  if (found.length > 0) {
    const changed = changedLines(board.transit, found)

    board.transit = found

    for (const line of changed) {
      $.ui.toast(
        line.isNormal ? `${line.name}は平常運転に戻りました` : `${line.name}: ${line.text}`,
        { timeoutMs: 8000 },
      )
    }
  }

  await repaint($, board)
}

/**
 * マーキーを 1 セル進める。
 *
 * ターン中は止める。`$.ui.invalidate` は 10/s までで、処理中は zawa-claude の
 * スピナーが枠を使うので、ここまで重ねると上限に触れる。待機中だけ流す。
 */
async function stepMarquee($: EngineInterface, board: Board): Promise<void> {
  if (!board.isShown || !board.isOpen || board.isWorking) {
    return
  }

  if (board.transit.length === 0 && board.news.text === '' && !hasAlerts(board.alerts)) {
    return
  }

  board.step += 1

  await repaint($, board)
}

/** 姿が変わっていれば描き直す。 */
/**
 * 時間帯の出入りを見る。入った瞬間にまとめて取りにいき、出入りのたびに描き直す。
 *
 * 時間帯の外では取得も描画もしない（17:00 より前に通信しない）。
 */
async function checkWindow($: EngineInterface, board: Board): Promise<void> {
  const isOpen = board.isShown && isWithin(board.window, await $.clock.now())

  if (isOpen === board.isOpen) {
    return
  }

  board.isOpen = isOpen

  if (isOpen) {
    void fetchWeather($, board)
    void fetchTransit($, board)
    void fetchAlerts($, board)
    void fetchNews($, board)
    void fetchStock($, board)
  }

  $.ui.invalidate('ui.render')
}

async function repaint($: EngineInterface, board: Board): Promise<void> {
  const weather = `${board.sky}|${board.weather?.at ?? ''}|${board.weatherAt}|${board.forecast.pop ?? ''}/${board.forecast.high ?? ''}/${board.forecast.low ?? ''}/${board.forecast.sunset ?? ''}`
  const stale = `${board.weatherStale ? 1 : 0}${board.transitStale ? 1 : 0}${board.stockStale ? 1 : 0}`
  const rails = board.transit.map(line => `${line.name}:${line.isNormal ? 1 : 0}:${line.text}`).join('/')
  const alerts = `${board.alerts.warnings.map(warning => warning.code).join(',')}|${board.alerts.quake?.eid ?? ''}`
  const quote = `${board.quote?.price ?? ''}/${board.quote?.at ?? ''}/${board.quote?.volume ?? ''}|${board.period}|${board.charts[board.period]?.points.length ?? 0}|${board.ticks.list.length}`
  const shape = `${board.step}|${weather}|${stale}|${rails}|${alerts}|${board.news.text}|${quote}`

  if (shape === board.shown) {
    return
  }

  board.shown = shape

  $.ui.invalidate('ui.render')
}

/**
 * 東京の天気と運行情報を、プロンプトの上の帯に出す。
 *
 * @param on エンジンの登録口
 * @param options manifest の `userConfig` の値
 */
export const register: Register = (on, options) => {
  const board: Board = {
    isShown: booleanOf(options['enabled'], true),
    window: windowOf(stringOf(options['showFrom'], '17:00'), stringOf(options['showUntil'], '24:00')),
    isOpen: false,
    wanted: linesOf(stringOf(options['lines'], '山手線,東急田園都市線')),
    trainMs: numberOf(options['trainRefreshSec'], 180, 60, 3600) * 1000,
    weatherMs: numberOf(options['weatherRefreshSec'], 600, 300, 3600) * 1000,
    stockMs: numberOf(options['stockRefreshSec'], 180, 60, 3600) * 1000,
    marqueeMs: numberOf(options['marqueeMs'], 250, 100, 2000),
    point: stringOf(options['amedasPoint'], '44132'),
    latitude: numberOf(options['latitude'], 35.6895, -90, 90),
    longitude: numberOf(options['longitude'], 139.6917, -180, 180),
    warningArea: stringOf(options['warningArea'], '130010'),
    placeName: stringOf(options['placeName'], '東京'),
    quakeWindowMin: numberOf(options['quakeWindowMin'], 60, 5, 1440),
    showAlerts: booleanOf(options['alerts'], true),
    showNews: booleanOf(options['news'], true),
    // 旧 `newsFeed`（1 本だけ）が入っていれば、ラベル付きの 1 本として引き継ぐ。
    feeds: parseFeedSpecs(
      stringOf(
        options['newsFeeds'],
        stringOf(options['newsFeed'], '') === ''
          ? DEFAULT_NEWS_FEEDS
          : `NHK|${stringOf(options['newsFeed'], '')}`,
      ),
    ),
    newsCount: numberOf(options['newsCount'], 3, 1, 15),
    showStock: booleanOf(options['stock'], true),
    stockCode: stringOf(options['stockCode'], '7419'),
    period: 'number',
    charts: {},
    ticks: { on: '', list: [] },
    chartBusy: false,
    today: '',
    isWorking: false,
    weather: null,
    sky: 'cloud',
    forecast: NO_FORECAST,
    transit: [],
    alerts: NO_ALERTS,
    news: NO_NEWS,
    newsByFeed: {},
    quote: null,
    area: {},
    areaAtMs: -AREA_TTL_MS,
    weatherStale: false,
    transitStale: false,
    stockStale: false,
    weatherAt: '--:--',
    step: 0,
    shown: '',
    timers: [],
  }

  on('session.start', ($, e, next) => {
    if (board.timers.length === 0 && board.isShown) {
      // 前に選んでいた面と、取ってあった時系列を戻す。
      void restore($, board)
      board.timers.push(
        $.clock.every(board.weatherMs, () => {
          void fetchWeather($, board)
        }),
        $.clock.every(board.trainMs, () => {
          void fetchTransit($, board)
        }),
        $.clock.every(ALERT_MS, () => {
          void fetchAlerts($, board)
        }),
        $.clock.every(NEWS_MS, () => {
          void fetchNews($, board)
        }),
        $.clock.every(board.stockMs, () => {
          void fetchStock($, board)
        }),
        $.clock.every(board.marqueeMs, () => {
          void stepMarquee($, board)
        }),
      )

      // 時間帯を 30 秒ごとに見直す。入った瞬間に 1 度まとめて取りにいく。
      board.timers.push(
        $.clock.every(WINDOW_CHECK_MS, () => {
          void checkWindow($, board)
        }),
      )

      void checkWindow($, board)
    }

    return next(e)
  })

  // 見出しのボタン。押すと次の面へ進み、覚えておく。
  on('ui.press', { element: STOCK_BUTTON }, async ($, e, next) => {
    board.period = nextPeriod(board.period)

    await $.store.set('stock.period', board.period)

    $.ui.invalidate('ui.render')

    void ensureChart($, board)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    board.isWorking = true

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      board.isWorking = false

      // 作業中に時間帯へ入ると、入った瞬間の取得が止められている。空なら今取りにいく。
      if (board.isOpen && board.weather === null) {
        void fetchWeather($, board)
      }

      if (board.isOpen && board.transit.length === 0) {
        void fetchTransit($, board)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    // 下に居るもの（待機 Clawd や花火）は消さず、ボードの下に並べる。
    const beneath = await next(e)


    if (!board.isShown || !board.isOpen || e.props.hasSurvey || PANEL_ROWS + 1 > e.props.maxRows) {
      return beneath
    }

    const { Box, Text, Link, Button } = $.ui.resolve(e)

    // 株価パネルは 3 面目。横が足りないときは出さない（天気と掲示板を守る）。
    const hasStock =
      board.showStock && e.props.bodyColumns >= PANEL_WIDTH * 2 + BOARD_MIN + GUTTER * 3
    const sides = PANEL_WIDTH + GUTTER + (hasStock ? PANEL_WIDTH + GUTTER : 0)
    const room = Math.max(PANEL_WIDTH + sides, e.props.bodyColumns - GUTTER)
    const railsWidth = Math.max(BOARD_MIN, Math.min(room - sides, BOARD_MAX))
    const width = sides + railsWidth
    const alerts = board.showAlerts ? board.alerts : NO_ALERTS
    const panel = weatherPanel(
      board.sky,
      board.weather,
      board.weatherStale,
      board.weatherAt,
      board.forecast,
      board.placeName,
    )
    const news = board.showNews ? board.news : NO_NEWS
    const rails = transitBoard(board.transit, railsWidth, board.step, board.transitStale, {
      alert: alerts,
      news: news.text,
      place: board.placeName,
    })
    // ニュース行は見出しごとに別々のリンクにするので、断片に切って組み立てる。
    const newsRuns = marqueeRunsOf(news, newsWindowOf(railsWidth), board.step)
    const face = chartOf(board)
    const stock = stockPanel(board.quote, board.stockStale, face)
    const stockHead = stockHeadOf(board.quote, board.period)

    // 掲示板の行の並び（枠 → 路線 → ⚠ → 空行 → NHK → 枠）に合わせてリンクを配る。
    const alertRows = hasAlerts(alerts) ? 1 : 0
    const railCount = Math.min(board.transit.length, BOARD_ROWS - 3 - alertRows)
    const alertAt = alertRows === 0 ? -1 : 1 + railCount
    const newsAt = BOARD_ROWS - 2

    /** 1 行ぶんの色付きの字。 */
    const runsOf = (line: Line): unknown =>
      line.map(run => (
        <Text
          color={run.color}
          backgroundColor={run.backgroundColor}
          dimColor={run.dimColor}
          bold={run.bold}
        >
          {run.text}
        </Text>
      ))

    /**
     * ボタンの押し込み。中身は `ui.press` フックで進めるので、ここは何もしない。
     *
     * （`$` をトップレベル以外の関数に閉じ込めると `validate --strict` が嫌がる）
     */
    const pressFace = (): void => undefined

    /** 見出しの行だけリンクにする。 */
    const panelOf = (lines: Line[], href: string): unknown =>
      lines.map((line, index) =>
        index === 0 ? (
          <Link href={href}>{runsOf(line)}</Link>
        ) : (
          <Text wrap="truncate-end">{runsOf(line)}</Text>
        ),
      )

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={GUTTER}>
          <Box flexDirection="column">{panelOf(panel, FORECAST_URL)}</Box>
          <Box flexDirection="column">
            {rails.map((line, index) => {
              // ニュース行だけは、見出しごとに別々のリンクを張るため自分で組む。
              if (index === newsAt) {
                return (
                  <Box flexDirection="row">
                    <Text color={BOARD_FRAME}>║</Text>
                    <Text color={NEWS_LABEL} backgroundColor={BOARD_BACK} bold={true}>
                      {NEWS_HEAD}
                    </Text>
                    {newsRuns.map(run =>
                      run.href === null || run.href === '' ? (
                        <Text color={NEWS_TEXT} backgroundColor={BOARD_BACK}>
                          {run.text}
                        </Text>
                      ) : (
                        <Link href={run.href}>
                          <Text color={NEWS_TEXT} backgroundColor={BOARD_BACK}>
                            {run.text}
                          </Text>
                        </Link>
                      ),
                    )}
                    <Text color={BOARD_FRAME}>║</Text>
                  </Box>
                )
              }

              const status = index >= 1 && index <= railCount ? board.transit[index - 1] : undefined
              const href =
                status !== undefined
                  ? diainfoUrl(status.id)
                  : index === alertAt
                    ? WARNING_PAGE_URL
                    : null

              return href === null ? (
                <Text wrap="truncate-end">{runsOf(line)}</Text>
              ) : (
                <Link href={href}>{runsOf(line)}</Link>
              )
            })}
          </Box>
          {hasStock ? (
            <Box flexDirection="column">
              {/* 見出しは面を切り替えるボタン。押すと数字 → 1日 → … と回る。 */}
              <Box flexDirection="row">
                <Link href={quoteUrl(board.stockCode)}>{runsOf(stockHead.before)}</Link>
                <Button
                  key={STOCK_BUTTON}
                  label={stockHead.label}
                  onPress={pressFace}
                />
                {runsOf(stockHead.after)}
              </Box>
              {stock.slice(1).map(line => (
                <Text wrap="truncate-end">{runsOf(line)}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
        {beneath}
      </Box>
    )
  })
}
