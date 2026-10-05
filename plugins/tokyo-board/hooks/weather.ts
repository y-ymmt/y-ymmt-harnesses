/**
 * 気象庁アメダスの実況と、Open-Meteo の天気コード。
 *
 * アメダスは `latest_time.txt`（ISO 時刻）→ `point/{地点}/{YYYYMMDD}_{HH}.json` の順で
 * 引く。`HH` は 3 時間刻み（00,03,…,21）に丸める。JSON は観測時刻をキーにした表で、
 * 値は `[値, 品質]` の組。
 */

/** アメダスの最新時刻。 */
export const LATEST_TIME_URL = 'https://www.jma.go.jp/bosai/amedas/data/latest_time.txt'

/** 東京の天気予報ページ（天気パネルのリンク先）。 */
export const FORECAST_URL =
  'https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=130000'

/** アメダスの実況。 */
export type Amedas = {
  /** 気温（°C）。取れなければ null。 */
  readonly temp: number | null
  /** 前 1 時間の降水（mm）。 */
  readonly precipitation: number | null
  /** 湿度（%）。 */
  readonly humidity: number | null
  /** 風速（m/s）。 */
  readonly wind: number | null
  /** 観測時刻（`HH:MM`）。 */
  readonly at: string
}

/** ISO 時刻を、アメダスのファイル名（日付と 3 時間刻みの時）に割る。 */
export function amedasSlotOf(iso: string): { day: string; hour: string } {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(iso)

  if (matched === null) {
    return { day: '', hour: '' }
  }

  const [, year = '', month = '', day = '', hour = ''] = matched
  const slot = Math.floor(Number(hour) / 3) * 3

  return { day: `${year}${month}${day}`, hour: String(slot).padStart(2, '0') }
}

/**
 * 実況の JSON の URL。
 *
 * @param point 地点番号（東京は 44132）
 * @param iso `latest_time.txt` が返した時刻
 */
export function amedasUrl(point: string, iso: string): string {
  const { day, hour } = amedasSlotOf(iso)

  return `https://www.jma.go.jp/bosai/amedas/data/point/${point}/${day}_${hour}.json`
}

/** `[値, 品質]` の組から値だけ取る。 */
function valueOf(pair: unknown): number | null {
  return Array.isArray(pair) && typeof pair[0] === 'number' ? pair[0] : null
}

/**
 * 表のいちばん新しい観測を読む。
 *
 * @param table 実況の JSON（`{ "20260916103000": { temp: [21.1, 0], ... } }`）
 */
export function latestOf(table: Readonly<Record<string, unknown>>): Amedas | null {
  const keys = Object.keys(table)
    .filter(key => /^\d{14}$/.test(key))
    .sort()
  const key = keys[keys.length - 1]

  if (key === undefined) {
    return null
  }

  const row = table[key]

  if (typeof row !== 'object' || row === null) {
    return null
  }

  const fields = row as Record<string, unknown>

  return {
    temp: valueOf(fields['temp']),
    precipitation: valueOf(fields['precipitation1h']),
    humidity: valueOf(fields['humidity']),
    wind: valueOf(fields['wind']),
    at: `${key.slice(8, 10)}:${key.slice(10, 12)}`,
  }
}

/** 空模様。 */
export type Sky = 'clear' | 'cloud' | 'fog' | 'rain' | 'snow' | 'shower' | 'storm'

/**
 * WMO の天気コードを空模様に均す。
 *
 * @param code Open-Meteo の `current.weather_code`
 */
export function skyOf(code: number): Sky {
  if (code >= 95) return 'storm'
  if (code >= 80) return 'shower'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 51 && code <= 67) return 'rain'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 1 && code <= 3) return 'cloud'

  return 'clear'
}

/** 天気アイコン（8 セル x 4 行、幅 1 の BMP 文字だけ）。 */
export const SKY_ART: Readonly<Record<Sky, readonly string[]>> = {
  clear: ['  ▗▄▖   ', ' ▐███▌  ', '  ▝▀▘   ', ' ╲ │ ╱  '],
  cloud: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', '        '],
  fog: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', ' ▁▁ ▁▁  '],
  rain: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', ' ╱ ╱ ╱  '],
  snow: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', ' * * *  '],
  shower: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', '╱ ╱ ╱ ╱ '],
  storm: ['  ▄▄▄   ', ' ▟███▙  ', '▝▀▀▀▀▀▘ ', '  ▞▚    '],
}

/** 空模様ごとの色（アイコンと枠）。 */
export const SKY_COLOR: Readonly<Record<Sky, string>> = {
  clear: '#FFD93C',
  cloud: '#B7C2CC',
  fog: '#9AA5AE',
  rain: '#4AA3FF',
  snow: '#CFE8FF',
  shower: '#4AA3FF',
  storm: '#A965FF',
}

/** 空模様の呼び名。 */
export const SKY_NAME: Readonly<Record<Sky, string>> = {
  clear: '晴',
  cloud: '曇',
  fog: '霧',
  rain: '雨',
  snow: '雪',
  shower: 'にわか雨',
  storm: '雷',
}

/**
 * Open-Meteo の URL。
 *
 * @param latitude 緯度
 * @param longitude 経度
 */
export function openMeteoUrl(latitude: number, longitude: number): string {
  return (
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${latitude}&longitude=${longitude}` +
    '&current=weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset' +
    '&forecast_days=1&timezone=Asia%2FTokyo'
  )
}

/** きょうの見通し。 */
export type Forecast = {
  /** 降水確率（%）。 */
  readonly pop: number | null
  /** 最高・最低気温（°C）。 */
  readonly high: number | null
  readonly low: number | null
  /** 日の入り（`HH:MM`）。 */
  readonly sunset: string | null
}

/** まだ何も取れていないときの見通し。 */
export const NO_FORECAST: Forecast = { pop: null, high: null, low: null, sunset: null }

/** 気象庁の府県天気予報（降水確率を持っている）。 */
export function jmaForecastUrl(area: string): string {
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${area}.json`
}

/** 配列の先頭を数として読む。 */
function firstNumberOf(value: unknown): number | null {
  const parsed = Array.isArray(value) ? Number(value[0]) : Number.NaN

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Open-Meteo の `daily` から、きょうのぶんを読む。
 *
 * @param parsed 予報の JSON を JSON.parse したもの
 */
export function dailyOf(parsed: unknown): Forecast {
  const daily = (parsed as { daily?: Record<string, unknown> })?.daily

  if (daily === undefined || daily === null) {
    return NO_FORECAST
  }

  const sunset = Array.isArray(daily['sunset']) ? String(daily['sunset'][0] ?? '') : ''

  return {
    pop: firstNumberOf(daily['precipitation_probability_max']),
    high: firstNumberOf(daily['temperature_2m_max']),
    low: firstNumberOf(daily['temperature_2m_min']),
    sunset: /T(\d{2}:\d{2})/.exec(sunset)?.[1] ?? null,
  }
}

/**
 * 気象庁の予報から、いまの時間帯の降水確率を読む。
 *
 * 降水確率は 6 時間ごと（`timeSeries[1]`）。いまが入っている区切りを取り、
 * まだ最初の区切りにも達していなければ先頭を取る。
 *
 * @param parsed `forecast/{府県コード}.json` を JSON.parse したもの
 * @param area 区域コード（東京地方は `130010`）
 * @param nowMs いまの時刻（ミリ秒）
 */
export function popOf(parsed: unknown, area: string, nowMs: number): number | null {
  const root = Array.isArray(parsed) ? (parsed[0] as { timeSeries?: unknown }) : null
  const series = Array.isArray(root?.timeSeries) ? (root.timeSeries as Record<string, unknown>[]) : []

  for (const entry of series) {
    const times = Array.isArray(entry['timeDefines']) ? (entry['timeDefines'] as string[]) : []
    const areas = Array.isArray(entry['areas']) ? (entry['areas'] as Record<string, unknown>[]) : []
    const found = areas.find(
      row => (row['area'] as { code?: unknown } | undefined)?.code === area,
    )
    const pops = Array.isArray(found?.['pops']) ? (found['pops'] as string[]) : null

    if (pops === null || pops.length === 0) {
      continue
    }

    let at = 0

    times.forEach((time, index) => {
      if (Date.parse(time) <= nowMs && index < pops.length) {
        at = index
      }
    })

    const value = Number(pops[at])

    return Number.isFinite(value) ? value : null
  }

  return null
}
