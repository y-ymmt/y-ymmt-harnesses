/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// エンジンは JSX を大域の `h` で組む。上のプラグマは、tsconfig を読まない場所から
// `bun test` したときも同じ組み方にするためのもの。
import { isWithin, periodStartOf, windowOf } from './window'
import type { ShowWindow } from './window'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from './band'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import {
  BOARD_BACK,
  BOARD_FRAME,
  BOARD_ROWS,
  NEWS_HEAD,
  NEWS_LABEL,
  NEWS_TEXT,
  PANEL_ROWS,
  PANEL_WIDTH,
  newsWindowOf,
  transitBoard,
  weatherPanel,
} from './board'
import type { Line } from './board'
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
  LATEST_TIME_URL,
  NO_FORECAST,
  amedasUrl,
  dailyOf,
  forecastPageUrl,
  jmaForecastUrl,
  latestOf,
  officeOf,
  openMeteoUrl,
  popOf,
  skyOf,
} from './weather'
import type { Amedas, Forecast, Sky } from './weather'
import {
  NO_ALERTS,
  QUAKE_URL,
  hasAlerts,
  newAlertsOf,
  parseWarnings,
  quakeOf,
  warningPageUrl,
  warningUrl,
} from './alerts'
import type { Alerts } from './alerts'
import {
  DEFAULT_NEWS_FEEDS,
  NEWS_URL_FALLBACK,
  NO_NEWS,
  interleave,
  isNhkSite,
  marqueeRunsOf,
  matchesKeywords,
  newsLineOf,
  parseFeed,
  parseFeedSpecs,
} from './news'
import type { FeedSpec, NewsItem, NewsLine } from './news'

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

/** ボタンで決めた表示を覚えておく `$.store` の key。 */
const OVERRIDE_KEY = 'board.override'

/**
 * `$.store` に覚えておく、ボタンで決めた表示。
 *
 * `period` は決めたときの回の始まり（`periodStartOf`）。別の回（きのうの夜、昼のあいだ
 * など）に決めたものは、次のセッションでは捨てる。
 */
type StoredOverride = { readonly value: 'show' | 'hide'; readonly period: number }

/**
 * 覚えておいた値を読む。今の回に決めたものでなければ null（前の版の、回を持たない
 * 文字列だけの値も、いつ決めたか分からないので捨てる）。
 *
 * @param stored `$.store` から読んだ値
 * @param period 今の回の始まり
 */
function storedOverrideOf(stored: unknown, period: number): 'show' | 'hide' | null {
  if (typeof stored !== 'object' || stored === null) return null

  const { value, period: at } = stored as Partial<Record<keyof StoredOverride, unknown>>

  return (value === 'show' || value === 'hide') && at === period ? value : null
}

/**
 * セッションの始まりに、時間帯の中か外かと、前にボタンで決めた表示を、この順に読む。
 *
 * 時間帯の見直し（`checkWindow`）より前に済ませる。見直しが先に走ると、起動直後の
 * 「外 → 中」を時間帯の出入りと取り違え、覚えておいた表示を消してしまう。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function start($: EngineInterface, board: Board): Promise<void> {
  const nowMs = await $.clock.now()
  const period = periodStartOf(board.window, nowMs)
  const stored = await $.store.get(OVERRIDE_KEY)
  const override = storedOverrideOf(stored, period)

  board.isOpen = isWithin(board.window, nowMs)
  board.period = period
  board.override = override
  board.isStarted = true

  // 別の回に決めた表示は捨て、いつもの時間割に戻す。
  if (override === null && stored !== null && stored !== undefined) {
    void $.store.set(OVERRIDE_KEY, null)
  }

  if (isVisible(board)) fetchAll($, board)

  $.ui.invalidate('ui.render')
}

/** ボードを出し入れするボタンの key。帯のいちばん下に固定で置く。 */
const TOGGLE_BUTTON = 'board-toggle'

// ボタンの常時の背景（ホバーの反転とは別の層）。Button には背景色の指定が無い（文字のスタイルと
// hover だけ）ので Box で包んで塗る。テーマの userMessageBackground では薄くて見えなかったので、
// 暗い背景で目立つ濃い灰青にする。
const CHIP_BACK = '#4b5470'

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
  /** 今の回（時間帯の中か外かが続いているひとまとまり）の始まり（`periodStartOf`）。 */
  period: number
  /** `start` が済んだか。済むまでは時間帯の見直しをしない。 */
  isStarted: boolean
  /**
   * 人がボタンで決めた表示。null なら時間帯どおり（中なら出す、外なら畳む）。
   * 時間帯の出入りのたびに null に戻し、いつもの時間割に従う。
   */
  override: 'show' | 'hide' | null
  /** 見たい路線（設定 `lines`）。 */
  readonly wanted: readonly string[]
  /** 取りにいく間隔（ミリ秒）。 */
  readonly trainMs: number
  readonly weatherMs: number
  /** マーキーが 1 セル進むまで（ミリ秒）。 */
  readonly marqueeMs: number
  /** アメダスの地点と、天気アイコンを引く座標。 */
  readonly point: string
  readonly latitude: number
  readonly longitude: number
  /** 警報・地震を見る区域（東京地方は `130010`）と、地震を出す時間の窓（分）。 */
  readonly warningArea: string
  /** その府県コード（`130000`）。予報・警報の JSON と、気象庁のページのリンクに使う。 */
  readonly office: string
  /** 見出しと震度の前に出す地名（設定 `placeName`）。 */
  readonly placeName: string
  readonly quakeWindowMin: number
  readonly showAlerts: boolean
  /** ニュース。 */
  readonly showNews: boolean
  readonly feeds: readonly FeedSpec[]
  /** 配信元 1 つあたりの見出しの本数。 */
  readonly newsCount: number
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
  /** 路線名 → id。1 日覚えておく。 */
  area: Record<string, string>
  areaAtMs: number
  /** それぞれ、取りにいけなかったか（薄字で出す）。 */
  weatherStale: boolean
  transitStale: boolean
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
  if (!isVisible(board) || board.isWorking) {
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
  const jma = await getText($, jmaForecastUrl(board.office))

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
  if (!isVisible(board) || !board.showAlerts || board.isWorking) {
    return
  }

  const nowMs = await $.clock.now()
  const warningText = await getText($, warningUrl(board.office))
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
  if (!isVisible(board) || !board.showNews || board.feeds.length === 0) {
    return
  }

  if (board.isWorking) {
    return
  }

  for (const feed of board.feeds) {
    const primary = await getText($, feed.url)
    const xml =
      primary ?? (isNhkSite(feed.url) ? await getText($, NEWS_URL_FALLBACK) : null)

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
 * 運行情報を取りにいく。路線名 → id は 1 日覚えておく。
 *
 * 平常 ↔ 異常が入れ替わったらトーストで知らせる（ターン中でも鳴る）。
 *
 * @param $ エンジン
 * @param board このセッションの状態
 */
async function fetchTransit($: EngineInterface, board: Board): Promise<void> {
  if (!isVisible(board) || board.isWorking) {
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
 * ターン中は止める。`$.ui.invalidate` は 10/s までで、処理中は turn-counter の
 * スピナーが枠を使うので、ここまで重ねると上限に触れる。待機中だけ流す。
 */
async function stepMarquee($: EngineInterface, board: Board): Promise<void> {
  if (!isVisible(board) || board.isWorking) {
    return
  }

  if (board.transit.length === 0 && board.news.text === '' && !hasAlerts(board.alerts)) {
    return
  }

  board.step += 1

  await repaint($, board)
}

/** 今ボードを出すか。人の指定があればそれ、無ければ時間帯どおり。 */
function isVisible(board: Board): boolean {
  if (!board.isShown) return false

  return board.override === null ? board.isOpen : board.override === 'show'
}

/** 取りにいくものをまとめて取りにいく（ボードを出し始めたとき用）。 */
function fetchAll($: EngineInterface, board: Board): void {
  void fetchWeather($, board)
  void fetchTransit($, board)
  void fetchAlerts($, board)
  void fetchNews($, board)
}

/** 人の指定を変え、出し始めたなら取りにいって、描き直す。 */
async function setOverride($: EngineInterface, board: Board, override: 'show' | 'hide' | null): Promise<void> {
  const was = isVisible(board)

  board.override = override

  const stored: StoredOverride | null = override === null ? null : { value: override, period: board.period }

  await $.store.set(OVERRIDE_KEY, stored)

  if (!was && isVisible(board)) fetchAll($, board)

  $.ui.invalidate('ui.render')
}

/**
 * 時間帯の出入りを見る。入った瞬間にまとめて取りにいき、出入りのたびに描き直す。
 *
 * 時間帯の外では取得も描画もしない（17:00 より前に通信しない）。セッションの始まりの
 * 判定は `start` がするので、それが済むまでは何もしない。回の始まりも見るので、
 * PC が眠っているあいだに時間帯をまたいだときも出入りとして扱う。
 */
async function checkWindow($: EngineInterface, board: Board): Promise<void> {
  if (!board.isStarted) {
    return
  }

  const nowMs = await $.clock.now()
  const isOpen = isWithin(board.window, nowMs)
  const period = periodStartOf(board.window, nowMs)

  if (isOpen === board.isOpen && period === board.period) {
    return
  }

  const was = isVisible(board)

  board.isOpen = isOpen
  board.period = period

  // 時間帯の出入りでは人の指定を解き、いつもの時間割に戻す（昼に出したものは夜中に畳む、など）。
  if (board.override !== null) {
    board.override = null
    void $.store.set(OVERRIDE_KEY, null)
  }

  if (!was && isVisible(board)) fetchAll($, board)

  $.ui.invalidate('ui.render')
}

/** 姿が変わっていれば描き直す。 */
async function repaint($: EngineInterface, board: Board): Promise<void> {
  const weather = `${board.sky}|${board.weather?.at ?? ''}|${board.weatherAt}|${board.forecast.pop ?? ''}/${board.forecast.high ?? ''}/${board.forecast.low ?? ''}/${board.forecast.sunset ?? ''}`
  const stale = `${board.weatherStale ? 1 : 0}${board.transitStale ? 1 : 0}`
  const rails = board.transit.map(line => `${line.name}:${line.isNormal ? 1 : 0}:${line.text}`).join('/')
  const alerts = `${board.alerts.warnings.map(warning => warning.code).join(',')}|${board.alerts.quake?.eid ?? ''}`
  const shape = `${board.step}|${weather}|${stale}|${rails}|${alerts}|${board.news.text}`

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
    period: 0,
    isStarted: false,
    override: null,
    wanted: linesOf(stringOf(options['lines'], '山手線,東急田園都市線')),
    trainMs: numberOf(options['trainRefreshSec'], 180, 60, 3600) * 1000,
    weatherMs: numberOf(options['weatherRefreshSec'], 600, 300, 3600) * 1000,
    marqueeMs: numberOf(options['marqueeMs'], 250, 100, 2000),
    point: stringOf(options['amedasPoint'], '44132'),
    latitude: numberOf(options['latitude'], 35.6895, -90, 90),
    longitude: numberOf(options['longitude'], 139.6917, -180, 180),
    warningArea: stringOf(options['warningArea'], '130010'),
    office: officeOf(stringOf(options['warningArea'], '130010')),
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
    isWorking: false,
    weather: null,
    sky: 'cloud',
    forecast: NO_FORECAST,
    transit: [],
    alerts: NO_ALERTS,
    news: NO_NEWS,
    newsByFeed: {},
    area: {},
    areaAtMs: -AREA_TTL_MS,
    weatherStale: false,
    transitStale: false,
    weatherAt: '--:--',
    step: 0,
    shown: '',
    timers: [],
  }

  on('session.start', ($, e, next) => {
    // 帯を描くのは端末（terminal）だけ。`-p`・SDK（e.surface が null）やデスクトップなど、
    // 描かないセッションでは取得もタイマーも始めない。e.surface は `$.session.surfaces()` の
    // 先頭で、端末があれば必ず先頭に来る。
    if (board.timers.length === 0 && board.isShown && e.surface === 'terminal') {
      // 時間帯の中か外かと、前にボタンで決めた表示を、この順に読む（読み終えるまで見直しは待つ）。
      void start($, board)
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
    }

    return next(e)
  })

  // 帯の下の固定ボタン。出していれば畳み、畳んでいれば出す。
  on('ui.press', { element: TOGGLE_BUTTON }, async ($, e, next) => {
    // 時間帯の中で畳むなら「隠す」、外で出すなら「出す」を覚える。
    // それ以外（中で隠していたのを出す、外で出していたのを畳む）は時間帯どおりに戻すだけ。
    const override = isVisible(board) ? (board.isOpen ? 'hide' : null) : board.isOpen ? null : 'show'

    await setOverride($, board, override)

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
      if (isVisible(board) && board.weather === null) {
        void fetchWeather($, board)
      }

      if (isVisible(board) && board.transit.length === 0) {
        void fetchTransit($, board)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    // 帯を使う他のプラグインの描画は消さず、並び順（band.ts）どおりに積み直す。
    const beneath = await next(e)

    if (!board.isShown || e.props.hasSurvey) {
      return beneath
    }

    const { Box, Text, Link, Button } = $.ui.resolve(e)

    /**
     * ボタンの押し込み。中身は `ui.press` フックで進めるので、ここは何もしない。
     *
     * （`$` をトップレベル以外の関数に閉じ込めると `validate --strict` が嫌がる）
     */
    const pressToggle = (): void => undefined

    // ボードの下に置く出し入れボタン。ボードの有無で位置が動かない。
    const visible = isVisible(board) && PANEL_ROWS + 1 <= e.props.maxRows
    const toggle = (
      <Box key={slotKey(BAND_ORDER.boardToggle, 'tokyo-board-toggle')} flexDirection="row">
        <Box key={`${TOGGLE_BUTTON}.chip`} flexShrink={0} backgroundColor={CHIP_BACK}>
          <Button
            key={TOGGLE_BUTTON}
            label={visible ? '天気・運行を隠す' : '天気・運行を表示'}
            dimColor
            onPress={pressToggle}
          />
        </Box>
      </Box>
    )

    // 出していないあいだ（隠した、または時間帯の外）はボタンだけ。
    if (!visible) {
      if (e.props.maxRows < 2) {
        return beneath
      }

      return (
        <Box key={BAND_STACK} flexDirection="column">
          {stackBand(beneath, [toggle])}
        </Box>
      )
    }

    // 天気パネル（＋間の余白）の残りを掲示板に回す。右端に 1 セル空け、BOARD_MIN〜BOARD_MAX に収める。
    const sides = PANEL_WIDTH + GUTTER
    const railsWidth = Math.max(BOARD_MIN, Math.min(e.props.bodyColumns - GUTTER - sides, BOARD_MAX))
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

    // 掲示板の行の並び（枠 → 路線 → ⚠ → 空行 → NHK → 枠）に合わせてリンクを配る。
    const alertRows = hasAlerts(alerts) ? 1 : 0
    const railCount = Math.min(board.transit.length, BOARD_ROWS - 3 - alertRows)
    const alertAt = alertRows === 0 ? -1 : 1 + railCount
    const newsAt = BOARD_ROWS - 2

    /** 1 行ぶんの色付きの字。 */
    const runsOf = (line: Line): RenderElement[] =>
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

    /** 見出しの行だけリンクにする。 */
    const panelOf = (lines: Line[], href: string): RenderElement[] =>
      lines.map((line, index) =>
        index === 0 ? (
          <Link href={href}>{runsOf(line)}</Link>
        ) : (
          <Text wrap="truncate-end">{runsOf(line)}</Text>
        ),
      )

    const panels = (
      <Box key={slotKey(BAND_ORDER.board, 'tokyo-board')} flexDirection="column" width={width}>
        <Box flexDirection="row" gap={GUTTER}>
          <Box flexDirection="column">{panelOf(panel, forecastPageUrl(board.office))}</Box>
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
                    ? warningPageUrl(board.office)
                    : null

              return href === null ? (
                <Text wrap="truncate-end">{runsOf(line)}</Text>
              ) : (
                <Link href={href}>{runsOf(line)}</Link>
              )
            })}
          </Box>
        </Box>
      </Box>
    )

    return (
      <Box key={BAND_STACK} flexDirection="column">
        {stackBand(beneath, [panels, toggle])}
      </Box>
    )
  })
}
