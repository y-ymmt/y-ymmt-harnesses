/**
 * ボードの組み立て。天気パネルと電光掲示板を「色の付いた文字の並び」にする。
 *
 * `Raster` は使わない（全角が入らないため）。1 行を `Run` の並びで表し、
 * `hooks.tsx` が `Text` に流す。
 */

import { NO_FORECAST, SKY_ART, SKY_COLOR, SKY_NAME } from './weather'
import type { Amedas, Forecast, Sky } from './weather'
import { lineColorOf } from './transit'
import type { LineStatus } from './transit'
import { NO_ALERTS, alertColorOf, alertTextOf, hasAlerts } from './alerts'
import type { Alerts } from './alerts'

/** 同じ見た目が続くひとまとまり。 */
export type Run = {
  readonly text: string
  readonly color?: string
  readonly backgroundColor?: string
  readonly dimColor?: boolean
  readonly bold?: boolean
}

/** 1 行。 */
export type Line = readonly Run[]

/** 端末で 2 セル分の幅を取る文字の範囲（East Asian Wide / Fullwidth）。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
]

/** 1 文字の表示幅（セル）。 */
export function charWidth(codePoint: number): number {
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 2 : 1
}

/** 文字列の表示幅（セル）。全角は 2。 */
export function displayWidth(text: string): number {
  let width = 0

  for (const character of text) {
    width += charWidth(character.codePointAt(0) ?? 0)
  }

  return width
}

/** 表示幅ちょうどに右を空白で埋める（長ければ切る）。 */
export function padTo(text: string, width: number): string {
  let out = ''
  let used = 0

  for (const character of text) {
    const next = charWidth(character.codePointAt(0) ?? 0)

    if (used + next > width) {
      break
    }

    out += character
    used += next
  }

  return out + ' '.repeat(Math.max(0, width - used))
}

/**
 * 電光掲示板の流れる文字。
 *
 * 右から入って左へ抜け、また右から出てくる。短い文でも必ず一周する。
 * 全角は 2 セルぶん進むので、切れ目にかかる全角は空白に置き換えて桁を守る。
 *
 * @param text 流す文
 * @param width 窓の幅（セル）
 * @param step 1 セルずつ進めた回数
 */
export function marqueeOf(text: string, width: number, step: number): string {
  const window = Math.max(1, Math.trunc(width))
  const span = displayWidth(text)
  const period = span + window

  if (period <= 0) {
    return ' '.repeat(window)
  }

  const start = ((Math.trunc(step) % period) + period) % period
  const cells: string[] = Array.from({ length: window }, () => ' ')

  // 文の左端は、窓の右端から入ってくる: 窓座標で `window - start`。
  let at = window - start

  for (const character of text) {
    const size = charWidth(character.codePointAt(0) ?? 0)

    if (at + size > 0 && at < window) {
      if (at >= 0 && at + size <= window) {
        cells[at] = character

        for (let i = 1; i < size; i += 1) {
          cells[at + i] = ''
        }
      } else {
        // 端にかかる全角は出さない（桁がずれるため）。
        for (let i = 0; i < size; i += 1) {
          if (at + i >= 0 && at + i < window) {
            cells[at + i] = ' '
          }
        }
      }
    }

    at += size
  }

  return cells.join('')
}

/**
 * 大きい数字の字形。1 文字は横 3 × 縦 6 のドットで、1 行が 1 ドット行。
 *
 * 端末のセルは縦長（約 1:2）なので、半分ブロック（`▀` `▄` `█`）で上下 2 ドットを
 * 1 セルに詰めると、ドットがほぼ正方形になって字が崩れない。6 ドット行 = 3 セル行。
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['###', '#.#', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '..#', '###'],
  '4': ['#.#', '#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '..#', '###'],
  '-': ['...', '...', '###', '###', '...', '...'],
  ' ': ['...', '...', '...', '...', '...', '...'],
}

/** 上下 2 ドットを 1 セルにする。 */
function halfBlockOf(upper: boolean, lower: boolean): string {
  return upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' '
}

/**
 * 1 文字ぶんの大きい数字（3 行 x 3 セル）。
 *
 * @param character 数字、`-`、空白
 */
function bigCharOf(character: string): readonly string[] {
  const dots = GLYPHS[character] ?? GLYPHS[' '] ?? []

  return [0, 1, 2].map(row => {
    const upper = dots[row * 2] ?? '...'
    const lower = dots[row * 2 + 1] ?? '...'

    return [0, 1, 2].map(column => halfBlockOf(upper[column] === '#', lower[column] === '#')).join('')
  })
}

/**
 * 数字を大きい字の 3 行にする。
 *
 * @param text `21` や `-3` のような、数字と `-` だけの文字列
 */
export function bigDigits(text: string): readonly string[] {
  const rows = ['', '', '']

  for (const character of text) {
    const glyph = bigCharOf(character)

    rows.forEach((_, index) => {
      rows[index] = `${rows[index] ?? ''}${glyph[index] ?? '   '} `
    })
  }

  return rows.map(row => row.trimEnd())
}

/** 天気パネルの幅（セル）。 */
export const PANEL_WIDTH = 26

/** パネルと掲示板の高さ（行）。天気パネルと掲示板を同じ高さに揃える。 */
export const PANEL_ROWS = 7

/** ボードの高さ（行）。 */
export const BOARD_ROWS = PANEL_ROWS

/** 数値を「21.1」のように見せる（無ければ `--`）。 */
function shownOf(value: number | null, digits = 1): string {
  return value === null ? '--' : value.toFixed(digits)
}

/**
 * 天気パネル（26 x 6）。
 *
 * 取得時刻は掲示板と揃えて、枠の中の右上（1 行目の右端）に灰色で置く。
 * 気温が 3 字（`-12` など）で右上に入らないときは見出しの罫線の中に置く。
 *
 * @param sky 空模様
 * @param amedas 実況（取れていなければ null）
 * @param isStale 取得に失敗して前回値を出しているか
 * @param at 取りにいった時刻（`HH:MM`）
 */
export function weatherPanel(
  sky: Sky,
  amedas: Amedas | null,
  isStale: boolean,
  at = '--:--',
  forecast: Forecast = NO_FORECAST,
  place = '東京',
): Line[] {
  const tint = SKY_COLOR[sky]
  const inner = PANEL_WIDTH - 2
  const title = ` ${place} ${SKY_NAME[sky]} `
  const art = SKY_ART[sky]
  const temp = amedas?.temp ?? null
  const whole = temp === null ? '--' : String(Math.trunc(Math.abs(temp)) * (temp < 0 ? -1 : 1))
  const big = bigDigits(whole)
  const fraction = temp === null ? '' : `.${Math.abs(Math.round(temp * 10) % 10)}°C`
  const stats = `湿度 ${shownOf(amedas?.humidity ?? null, 0)}% 雨${shownOf(amedas?.precipitation ?? null)}mm`

  // アイコンの右に、上 3 行が大きい気温、いちばん下が湿度と降水。
  const right = [big[0] ?? '', big[1] ?? '', `${big[2] ?? ''}${fraction}`, stats]
  const iconWidth = displayWidth(art[0] ?? '')
  const clock = ` ${at}`
  const clockFits = iconWidth + displayWidth(big[0] ?? '') + displayWidth(clock) <= inner
  const rule = Math.max(0, inner - displayWidth(title))

  const head: Line = clockFits
    ? [
        { text: '┌', color: tint },
        { text: title, color: tint, bold: true },
        { text: '─'.repeat(rule), color: tint },
        { text: '┐', color: tint },
      ]
    : [
        { text: '┌', color: tint },
        { text: title, color: tint, bold: true },
        { text: '─'.repeat(Math.max(0, rule - displayWidth(clock) - 2)), color: tint },
        { text: clock, color: '#8A8A8A', dimColor: isStale },
        { text: ' ─', color: tint },
        { text: '┐', color: tint },
      ]

  const body = art.map((row, index): Line => {
    const room = inner - displayWidth(row)
    const text = right[index] ?? ''

    if (index === 0 && clockFits) {
      // 1 行目は右端に取得時刻。掲示板の時刻と同じ灰色。
      return [
        { text: '│', color: tint },
        { text: row, color: tint },
        { text: padTo(text, room - displayWidth(clock)), color: '#F2F2F2' },
        { text: clock, color: '#8A8A8A', dimColor: isStale },
        { text: '│', color: tint },
      ]
    }

    return [
      { text: '│', color: tint },
      { text: row, color: tint },
      {
        text: padTo(text, room),
        color: index === 3 ? undefined : '#F2F2F2',
        bold: index === 2,
        dimColor: index === 3 && isStale,
      },
      { text: '│', color: tint },
    ]
  })

  const tail: Line = [
    { text: '└', color: tint },
    { text: '─'.repeat(inner), color: tint },
    { text: '┘', color: tint },
  ]

  return [head, ...body, forecastRow(forecast, inner, tint, isStale), tail]
}

/** きょうの見通しの色。 */
const FORECAST_COLOR = {
  pop: '#4AA3FF',
  high: '#FF8A6B',
  low: '#7FB2FF',
  sunset: '#D6B44A',
} as const

/**
 * 見通しの 1 行を組む候補。
 *
 * 枠は 26 セルと決まっていて、`降水90% ↑23° ↓20° 日没17:47` はそのままでは
 * 入らないことがある（気温が 3 桁、降水が 3 桁など）。入る形が見つかるまで
 * 短いほうへ落とす。
 */
function forecastPartsOf(forecast: Forecast): readonly (readonly string[])[] {
  const pop = `降水${forecast.pop === null ? '--' : Math.round(forecast.pop)}%`
  const high = forecast.high === null ? '--' : String(Math.round(forecast.high))
  const low = forecast.low === null ? '--' : String(Math.round(forecast.low))
  const sunset = forecast.sunset ?? '--:--'

  return [
    [pop, `↑${high}°`, `↓${low}°`, `日没${sunset}`],
    [pop, `↑${high}`, `↓${low}`, `日没${sunset}`],
    [pop, `↑${high}`, `↓${low}`, `没${sunset}`],
    [pop, `↑${high}`, `↓${low}`],
  ]
}

/**
 * 天気パネルのいちばん下、きょうの見通し。
 *
 * @param forecast きょうの降水確率・最高最低・日の入り
 * @param inner 枠の内側の幅（セル）
 * @param tint 枠の色
 * @param isStale 取れずに前回値を出しているか
 */
function forecastRow(forecast: Forecast, inner: number, tint: string, isStale: boolean): Line {
  const room = inner - 1
  const candidates = forecastPartsOf(forecast)
  const parts =
    candidates.find(part => displayWidth(part.join(' ')) <= room) ??
    candidates[candidates.length - 1] ??
    []
  const colors = [FORECAST_COLOR.pop, FORECAST_COLOR.high, FORECAST_COLOR.low, FORECAST_COLOR.sunset]
  const body: Run[] = []

  parts.forEach((part, index) => {
    body.push({ text: ' ' })
    body.push({ text: part, color: colors[index] ?? '#F2F2F2', dimColor: isStale })
  })

  const used = body.reduce((total, run) => total + displayWidth(run.text), 0)

  return [
    { text: '│', color: tint },
    ...body,
    { text: ' '.repeat(Math.max(0, inner - used)) },
    { text: '│', color: tint },
  ]
}

/**
 * ニュース行の、流れる窓の幅（セル）。
 *
 * @param width 掲示板ぜんぶの幅
 */
export function newsWindowOf(width: number): number {
  return Math.max(4, Math.max(10, Math.trunc(width) - 2) - 6)
}

/** 電光掲示板の地の色。 */
export const BOARD_BACK = '#111111'

/** 電光掲示板の枠の色。 */
export const BOARD_FRAME = '#5A6472'

/** 平常のときの LED 色。 */
export const LED_OK = '#39FF14'

/** 異常のときの LED 色。 */
export const LED_ALERT = '#FFA500'

/** ニュース行の見出しの色。 */
export const NEWS_LABEL = '#FFFFFF'

/** 流れる字の色。 */
export const NEWS_TEXT = '#E6E6E6'

/** ニュース行の見出し（この幅ぶんだけ流れる窓が狭くなる）。 */
export const NEWS_HEAD = ' NEWS '

/**
 * 警報の行の頭に置く印。
 *
 * `⚠`（U+26A0）は等幅フォントが持っていないことが多く、絵文字のほうへ落ちると
 * 2 セルぶんの幅になって掲示板の桁がずれる。幅 1 と決まっている `▲` を使う。
 */
const ALERT_MARK = '▲'

/**
 * 電光掲示板（幅は呼ぶ側が決める）。
 *
 * 高さは天気パネルと同じ 7 行で動かさない。内訳は枠 2 行 + 中身 5 行で、
 * 中身は「路線 → ⚠ → 空行 → NHK」の順に詰める。⚠ が出るときは空行が
 * 1 つ減るだけなので、警報が出ても掲示板の背は伸びない。
 *
 * @param lines 路線の状況
 * @param width 掲示板の幅（セル）
 * @param step マーキーを進めた回数
 * @param isStale 取得に失敗して前回値を出しているか
 * @param extra ⚠ 行に出すもの（警報・地震）と、NHK 行に流す見出し
 */
export function transitBoard(
  lines: readonly LineStatus[],
  width: number,
  step: number,
  isStale: boolean,
  extra: { readonly alert?: Alerts; readonly news?: string; readonly place?: string } = {},
): Line[] {
  const alert = extra.alert ?? NO_ALERTS
  const news = extra.news ?? ''
  const place = extra.place ?? '東京'
  const inner = Math.max(10, Math.trunc(width) - 2)
  const nameWidth = Math.min(
    16,
    Math.max(8, ...lines.map(line => displayWidth(line.name))) + 1,
  )
  const clock = lines[0]?.at ?? '--:--'
  const timeWidth = displayWidth(clock) + 1

  const head: Line = [{ text: `╔${'═'.repeat(inner)}╗`, color: BOARD_FRAME }]
  const tail: Line = [{ text: `╚${'═'.repeat(inner)}╝`, color: BOARD_FRAME }]

  // 1 行の中身は「■ + 路線名 + 流れる文 + 時刻」でちょうど `inner` セル。
  const window = Math.max(4, inner - 3 - nameWidth - timeWidth)
  const body = BOARD_ROWS - 2
  const alertRows = hasAlerts(alert) ? 1 : 0
  const shownLines = lines.slice(0, Math.max(0, body - 1 - alertRows))
  const blanks = Math.max(0, body - 1 - alertRows - shownLines.length)

  const rows = shownLines.map((line, index): Line => {
    const led = line.isNormal ? LED_OK : LED_ALERT

    return [
      { text: '║', color: BOARD_FRAME },
      { text: ' ■ ', color: lineColorOf(line.name), backgroundColor: BOARD_BACK },
      {
        text: padTo(line.name, nameWidth),
        color: '#E6E6E6',
        backgroundColor: BOARD_BACK,
      },
      {
        text: marqueeOf(line.text, window, step),
        color: led,
        backgroundColor: BOARD_BACK,
        bold: !line.isNormal,
      },
      {
        text: padTo(index === 0 ? ` ${clock}` : '', Math.max(0, inner - 3 - nameWidth - window)),
        color: '#8A8A8A',
        backgroundColor: BOARD_BACK,
        dimColor: isStale,
      },
      { text: '║', color: BOARD_FRAME },
    ]
  })

  const alerts: Line[] = alertRows === 0 ? [] : [alertRow(alert, inner, step, place)]
  const empty: Line[] = Array.from({ length: blanks }, () => blankRow(inner))

  return [head, ...rows, ...alerts, ...empty, newsRow(news, inner, step), tail]
}

/** 黒地のままの空行。 */
function blankRow(inner: number): Line {
  return [
    { text: '║', color: BOARD_FRAME },
    { text: ' '.repeat(inner), backgroundColor: BOARD_BACK },
    { text: '║', color: BOARD_FRAME },
  ]
}

/**
 * 警報・地震の行（⚠ 行）。ふだんは出ない。
 *
 * 入りきる短い文はそのまま置き、長ければ流す（`大雨警報 洪水警報 …` のように
 * 並ぶと窓を越えるため）。
 */
function alertRow(alert: Alerts, inner: number, step: number, place: string): Line {
  const room = Math.max(4, inner - 3)
  const text = alertTextOf(alert, place)
  const body = displayWidth(text) <= room ? padTo(text, room) : marqueeOf(text, room, step)

  return [
    { text: '║', color: BOARD_FRAME },
    { text: ` ${ALERT_MARK} `, color: alertColorOf(alert), backgroundColor: BOARD_BACK, bold: true },
    { text: body, color: alertColorOf(alert), backgroundColor: BOARD_BACK, bold: true },
    { text: '║', color: BOARD_FRAME },
  ]
}

/**
 * ニュースの見出しが流れる行。中身が無くても窓は黒いまま残す。
 *
 * 流れる窓の幅は `newsWindowOf` と同じ。リンク先を決めるのに呼ぶ側も要るので
 * 数の出どころを 1 つにしてある。
 */
function newsRow(news: string, inner: number, step: number): Line {
  const room = Math.max(4, inner - displayWidth(NEWS_HEAD))

  return [
    { text: '║', color: BOARD_FRAME },
    { text: NEWS_HEAD, color: NEWS_LABEL, backgroundColor: BOARD_BACK, bold: true },
    {
      text: news === '' ? ' '.repeat(room) : marqueeOf(news, room, step),
      color: '#E6E6E6',
      backgroundColor: BOARD_BACK,
    },
    { text: '║', color: BOARD_FRAME },
  ]
}

/** 取れていないときの一言。 */
export function staleNote(at: string): Line {
  return [{ text: `取得できず ${at}`, dimColor: true }]
}
