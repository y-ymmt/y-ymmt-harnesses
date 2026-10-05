/**
 * Yahoo!ファイナンス（日本）の銘柄ページから株価を読む。
 *
 * ページの HTML には、画面を組み立てるための JSON が「`"` を `\"` に逃がした
 * 文字列」として埋まっている。先に逃がしを戻すとふつうの JSON の形になるので、
 * あとは名前で引くだけで足りる。
 *
 * HTML の形が変わればここが壊れる。壊れたときは `parseQuote` が null を返し、
 * 画面には前回値と薄字が出る（README 参照）。
 */

/** 板の状態。 */
export type Quote = {
  /** 銘柄名（`(株)` は落とす）。 */
  readonly name: string
  /** 証券コード。 */
  readonly code: string
  /** 現在値（円）。 */
  readonly price: number | null
  /** 前日比（円）。上げが正。 */
  readonly change: number | null
  /** 騰落率（%）。 */
  readonly changeRate: number | null
  /** 始値・高値・安値・前日終値。 */
  readonly open: number | null
  readonly high: number | null
  readonly low: number | null
  readonly previousClose: number | null
  /** 出来高（株）。 */
  readonly volume: number | null
  /** 板の時刻（`HH:MM`）。 */
  readonly at: string
}

/** 値動きの向き。 */
export type Trend = 'up' | 'down' | 'flat'

/** 日本式の色。上げが赤、下げが緑。 */
export const TREND_COLOR: Readonly<Record<Trend, string>> = {
  up: '#FF4D4D',
  down: '#3DDC84',
  flat: '#9AA5AE',
}

/** 値動きの印。 */
export const TREND_MARK: Readonly<Record<Trend, string>> = {
  up: '▲',
  down: '▼',
  flat: '±',
}

/** 銘柄ページの URL。 */
export function quoteUrl(code: string): string {
  return `https://finance.yahoo.co.jp/quote/${code}.T`
}

/** `1,285` を数にする。`---` と空は null。 */
export function numberOfText(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null
  }

  const trimmed = raw.trim()

  if (trimmed === '' || trimmed.startsWith('---')) {
    return null
  }

  const parsed = Number(trimmed.replace(/,/g, ''))

  return Number.isFinite(parsed) ? parsed : null
}

/** `(株)ノジマ` を `ノジマ` にする。 */
export function shortNameOf(name: string): string {
  return name
    .replace(/[（(]株[)）]/g, '')
    .replace(/株式会社/g, '')
    .trim()
}

/** 逃がした `\"` を戻して、ふつうの JSON の形にする。 */
function unescaped(html: string): string {
  return html.replace(/\\"/g, '"')
}

/** 参考指標を名前で引く（`始値` など）。 */
function itemOf(text: string, name: string): string | undefined {
  return new RegExp(`"name":"${name}","value":"([^"]*)"`).exec(text)?.[1]
}

/**
 * 銘柄ページの HTML から板を読む。読めなければ null。
 *
 * @param html ページの HTML
 */
export function parseQuote(html: string): Quote | null {
  const text = unescaped(html)
  const at = text.indexOf('"priceBoard":{')

  if (at < 0) {
    return null
  }

  // 板は先頭 2000 字に収まる。後ろの「気配値」などを拾わないよう窓を切る。
  const board = text.slice(at, at + 2000)
  const name = /"name":"([^"]*)"/.exec(board)?.[1] ?? ''
  const code = /"code":"(\d{4}[A-Z0-9]?)"/.exec(board)?.[1] ?? ''
  const price = numberOfText(/"price":\{"value":"([^"]*)"/.exec(board)?.[1])
  const changeRaw = /"priceChange":\{"value":"([^"]*)"/.exec(board)?.[1]
  const rateRaw = /"priceChangeRate":\{"value":"([^"]*)"/.exec(board)?.[1]
  const previousClose = numberOfText(itemOf(text, '前日終値'))
  const change = numberOfText(changeRaw) ?? (price !== null && previousClose !== null ? price - previousClose : null)

  if (name === '' || price === null) {
    return null
  }

  return {
    name: shortNameOf(name),
    code,
    price,
    change,
    changeRate: numberOfText(rateRaw),
    open: numberOfText(itemOf(text, '始値')),
    high: numberOfText(itemOf(text, '高値')),
    low: numberOfText(itemOf(text, '安値')),
    previousClose,
    volume: numberOfText(itemOf(text, '出来高')),
    at: /"japanUpdateTime":"([^"]*)"/.exec(board)?.[1] ?? '--:--',
  }
}

/** 前日比から向きを決める。 */
export function trendOf(quote: Quote | null): Trend {
  const change = quote?.change ?? 0

  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
}

/**
 * 東証が開いているか（平日 8:55〜15:35 の JST）。
 *
 * 端末の時計がどの帯にあっても同じ答えになるよう、UTC から +9 時間して見る。
 * 祝日は見ない（休みの日はただ 3 分ごとに同じ終値を取り直すだけで害がない）。
 *
 * @param nowMs いまの時刻（ミリ秒）
 */
export function isMarketOpen(nowMs: number): boolean {
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000)
  const day = jst.getUTCDay()

  if (day === 0 || day === 6) {
    return false
  }

  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes()

  return minutes >= 8 * 60 + 55 && minutes <= 15 * 60 + 35
}

/**
 * 安値〜高値のあいだで、現在値の位置に `●` を置いた棒。
 *
 * 値が揃わないときと、安値＝高値のときは真ん中に置く。範囲の外に出ている
 * 現在値（気配で更新が追いついていないとき）は端に寄せる。
 *
 * @param low 安値
 * @param high 高値
 * @param price 現在値
 * @param width 棒ぜんぶの幅（`├` と `┤` を含む）
 */
export function rangeBarOf(
  low: number | null,
  high: number | null,
  price: number | null,
  width: number,
): string {
  const span = Math.max(3, Math.trunc(width))
  const inner = span - 2
  const middle = Math.floor((inner - 1) / 2)
  const ratio =
    low === null || high === null || price === null || high <= low
      ? null
      : (price - low) / (high - low)
  const at = ratio === null ? middle : Math.min(inner - 1, Math.max(0, Math.round(ratio * (inner - 1))))

  return `├${'─'.repeat(at)}●${'─'.repeat(inner - 1 - at)}┤`
}

/**
 * 出来高を「23.8万株」のように短くする。
 *
 * @param volume 株数
 */
export function volumeTextOf(volume: number | null): string {
  if (volume === null) {
    return '---'
  }

  if (volume >= 100_000_000) {
    return `${(volume / 100_000_000).toFixed(1)}億株`
  }

  if (volume >= 10_000) {
    return `${(volume / 10_000).toFixed(1)}万株`
  }

  return `${volume}株`
}

/** `1,285` のように 3 桁で区切る（無ければ `---`）。 */
export function commaOf(value: number | null): string {
  return value === null ? '---' : value.toLocaleString('en-US')
}
