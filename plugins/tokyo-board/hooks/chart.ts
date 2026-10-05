/**
 * 株価パネルのグラフ面。期間の巡回、時系列の読み取り、点字の折れ線。
 *
 * 折れ線は点字（U+2800〜）で描く。1 文字が横 2 × 縦 4 のドットなので、
 * 18 文字 × 4 行で 36 × 16 ドットになる。点字は幅 1 の BMP 文字なので、
 * 掲示板と同じく `Text` にそのまま流せる（`Raster` は要らない）。
 *
 * 時系列は Yahoo!ファイナンス（日本）の `history` ページに埋まっている JSON。
 * HTML の形が変わればここが壊れる。壊れたときは `parseHistory` が空を返し、
 * グラフ面には「取得できず」が出る（README 参照）。
 */

/** パネルの面。`number` が数字の板、ほかは期間ごとのグラフ。 */
export type Period = 'number' | 'day' | 'month' | 'quarter' | 'year' | 'fiveYear'

/** 切り替えの順。最後まで行くと数字に戻る。 */
export const PERIODS: readonly Period[] = [
  'number',
  'day',
  'month',
  'quarter',
  'year',
  'fiveYear',
]

/** ボタンに出す名前。 */
export const PERIOD_LABEL: Readonly<Record<Period, string>> = {
  number: '数字',
  day: '1日',
  month: '1か月',
  quarter: '3か月',
  year: '1年',
  fiveYear: '5年',
}

/** 次の面。 */
export function nextPeriod(period: Period): Period {
  const at = PERIODS.indexOf(period)

  return PERIODS[(at + 1) % PERIODS.length] ?? 'number'
}

/** 設定や `$.store` から読んだ値を面として読む。知らない値は数字の板。 */
export function periodOf(value: unknown): Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value)
    ? (value as Period)
    : 'number'
}

/** 日足 1 本。 */
export type HistoryPoint = {
  /** `YYYY-MM-DD`。 */
  readonly date: string
  /** 終値。 */
  readonly close: number
}

/** 当日の記録 1 点（3 分ごとの株価取得を貯めたもの）。 */
export type Tick = {
  /** `HH:MM`。 */
  readonly at: string
  readonly price: number
}

/** 期間ごとの取りにいき方。 */
export const PERIOD_FETCH: Readonly<
  Record<Exclude<Period, 'number' | 'day'>, { timeFrame: 'd' | 'w' | 'm'; pages: number; years: number }>
> = {
  month: { timeFrame: 'd', pages: 1, years: 0 },
  quarter: { timeFrame: 'd', pages: 3, years: 1 },
  year: { timeFrame: 'w', pages: 3, years: 2 },
  fiveYear: { timeFrame: 'm', pages: 3, years: 6 },
}

/** `YYYYMMDD`。 */
function stampOf(ms: number): string {
  const at = new Date(ms + 9 * 60 * 60 * 1000)

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}${String(at.getUTCDate()).padStart(2, '0')}`
}

/** 日本時間の `YYYY-MM-DD`（日付が変わったかを見るのに使う）。 */
export function jstDayOf(ms: number): string {
  const stamp = stampOf(ms)

  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
}

/**
 * 時系列ページの URL。
 *
 * @param code 銘柄コード
 * @param options 期間（`timeFrame`）、何ページ目か、期間の端
 */
export function historyUrl(
  code: string,
  options: { readonly timeFrame?: 'd' | 'w' | 'm'; readonly page?: number; readonly from?: string; readonly to?: string } = {},
): string {
  const query: string[] = []

  if (options.from !== undefined) {
    query.push(`from=${options.from}`)
  }

  if (options.to !== undefined) {
    query.push(`to=${options.to}`)
  }

  if (options.timeFrame !== undefined) {
    query.push(`timeFrame=${options.timeFrame}`)
  }

  if (options.page !== undefined && options.page > 1) {
    query.push(`page=${options.page}`)
  }

  const base = `https://finance.yahoo.co.jp/quote/${code}.T/history`

  return query.length === 0 ? base : `${base}?${query.join('&')}`
}

/**
 * ある期間のぶん、順に取りにいく URL。
 *
 * @param code 銘柄コード
 * @param period 面
 * @param nowMs いまの時刻（期間の端を決めるのに使う）
 */
export function historyUrlsOf(code: string, period: Period, nowMs: number): string[] {
  if (period === 'number' || period === 'day') {
    return []
  }

  const plan = PERIOD_FETCH[period]
  // 1 か月は素の URL（日足の既定）。ほかは期間を指定して取りにいく。
  const to = plan.years === 0 ? undefined : stampOf(nowMs)
  const from = plan.years === 0 ? undefined : stampOf(nowMs - plan.years * 365 * 24 * 60 * 60 * 1000)

  return Array.from({ length: plan.pages }, (_, index) =>
    plan.years === 0
      ? historyUrl(code, { page: index + 1 })
      : historyUrl(code, { timeFrame: plan.timeFrame, page: index + 1, from, to }),
  )
}

/** `1,264` を数にする。`---` と空は null。 */
function numberOfText(raw: string): number | null {
  const trimmed = raw.trim()

  if (trimmed === '' || trimmed.startsWith('---')) {
    return null
  }

  const parsed = Number(trimmed.replace(/,/g, ''))

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 時系列ページの HTML から日足を読む。古い順に返す。
 *
 * 1 行は `{"date":"…","values":[始,高,安,終,出来高,調整後終値,…]}`。同じ形で
 * 信用残の別表も入っているが、そちらは値が 5 つしかないので捨てる（終値の位置に
 * 別の数が入って、グラフが跳ねる）。
 *
 * @param html ページの HTML
 */
export function parseHistory(html: string): HistoryPoint[] {
  const text = html.replace(/\\"/g, '"')
  const found: HistoryPoint[] = []
  const seen = new Set<string>()

  for (const [, date = '', body = ''] of text.matchAll(
    /"date":"(\d{4}-\d{2}-\d{2})","values":\[([^\]]*)\]/g,
  )) {
    const values = [...body.matchAll(/"value":"([^"]*)"/g)].map(match => match[1] ?? '')

    // 日足は 8 値以上（始・高・安・終・出来高・調整後終値…）。5 値は別表。
    if (values.length < 8 || seen.has(date)) {
      continue
    }

    const close = numberOfText(values[3] ?? '')

    if (close === null) {
      continue
    }

    seen.add(date)
    found.push({ date, close })
  }

  return found.sort((a, b) => a.date.localeCompare(b.date))
}

/** 点字の下駄。 */
export const BRAILLE_BASE = 0x2800

/**
 * 点字 1 文字の中の、ドットの位置とビット。
 *
 * 左列が上から 1・2・3・7、右列が 4・5・6・8 の順に並ぶ、という決まりのため
 * 表を持っておく（`[列][行]`）。
 */
const DOT_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * 値の並びを、横 `width` ドットぶんに間引く（または引き伸ばす）。
 *
 * @param values 古い順の値
 * @param width 横のドット数
 */
export function resample(values: readonly number[], width: number): (number | null)[] {
  const room = Math.max(1, Math.trunc(width))

  if (values.length === 0) {
    return Array.from({ length: room }, () => null)
  }

  if (values.length === 1) {
    return Array.from({ length: room }, () => values[0] ?? null)
  }

  return Array.from({ length: room }, (_, index) => {
    const at = Math.round((index * (values.length - 1)) / (room - 1 || 1))

    return values[Math.min(values.length - 1, at)] ?? null
  })
}

/** 場が開いている時間（分）。9:00 から 15:30 まで。 */
const OPEN_MINUTE = 9 * 60
const CLOSE_MINUTE = 15 * 60 + 30

/**
 * 当日の記録を、9:00〜15:30 の横軸に並べる。記録の無い時間は空ける。
 *
 * @param ticks 当日の記録（`HH:MM` と値）
 * @param width 横のドット数
 */
export function intradaySlots(ticks: readonly Tick[], width: number): (number | null)[] {
  const room = Math.max(1, Math.trunc(width))
  const slots: (number | null)[] = Array.from({ length: room }, () => null)
  const span = CLOSE_MINUTE - OPEN_MINUTE

  for (const tick of ticks) {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(tick.at)

    if (matched === null || !Number.isFinite(tick.price)) {
      continue
    }

    const minute = Number(matched[1]) * 60 + Number(matched[2])
    const ratio = (minute - OPEN_MINUTE) / span
    const at = Math.round(Math.min(1, Math.max(0, ratio)) * (room - 1))

    slots[at] = tick.price
  }

  return slots
}

/** 値のある点の高安。1 つも無ければ null。 */
export function extentOf(slots: readonly (number | null)[]): { high: number | null; low: number | null } {
  const values = slots.filter((value): value is number => value !== null && Number.isFinite(value))

  if (values.length === 0) {
    return { high: null, low: null }
  }

  return { high: Math.max(...values), low: Math.min(...values) }
}

/**
 * 点字で折れ線を描く。
 *
 * 隣り合う点の段差は縦に埋めて線をつなぐ。空いている列（記録の無い時間）は
 * 何も打たず、そこで線を切る。値がぜんぶ同じときと 1 点だけのときは真ん中。
 *
 * @param slots 横のドットごとの値（空きは null）
 * @param columns 横の文字数
 * @param rows 縦の行数
 */
export function brailleRows(
  slots: readonly (number | null)[],
  columns: number,
  rows: number,
): string[] {
  const cells = Math.max(1, Math.trunc(columns))
  const lines = Math.max(1, Math.trunc(rows))
  const width = cells * 2
  const height = lines * 4
  const masks: number[] = Array.from({ length: cells * lines }, () => 0)
  const { high, low } = extentOf(slots)

  /** 値を上からのドット位置にする。 */
  const rowOf = (value: number): number => {
    if (high === null || low === null || high === low) {
      return Math.floor((height - 1) / 2)
    }

    return Math.min(height - 1, Math.max(0, Math.round(((high - value) / (high - low)) * (height - 1))))
  }

  /** 1 ドット打つ。 */
  const plot = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return
    }

    const at = Math.floor(y / 4) * cells + Math.floor(x / 2)

    masks[at] = (masks[at] ?? 0) | (DOT_BITS[x % 2]?.[y % 4] ?? 0)
  }

  let previous: { x: number; y: number } | null = null

  for (let x = 0; x < width; x += 1) {
    const value = slots[x] ?? null

    if (value === null || !Number.isFinite(value)) {
      previous = null
      continue
    }

    const y = rowOf(value)

    plot(x, y)

    // 隣の列から来ているときだけ、段差を縦に埋める。
    if (previous !== null && x - previous.x === 1) {
      const from = Math.min(previous.y, y)
      const to = Math.max(previous.y, y)

      for (let fill = from; fill <= to; fill += 1) {
        plot(x, fill)
      }
    }

    previous = { x, y }
  }

  return Array.from({ length: lines }, (_, line) =>
    Array.from({ length: cells }, (_, cell) =>
      String.fromCodePoint(BRAILLE_BASE + (masks[line * cells + cell] ?? 0)),
    ).join(''),
  )
}

/** `2026-09-15` を `09/15` にする。 */
export function shortDateOf(date: string): string {
  const matched = /^\d{4}-(\d{2})-(\d{2})$/.exec(date)

  return matched === null ? '' : `${matched[1]}/${matched[2]}`
}
