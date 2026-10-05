/**
 * Yahoo!路線情報の読み取り。
 *
 * 運行情報のページ（`/diainfo/{id}/0`）には `id="mdServiceStatus"` の塊があり、
 * その中の `<dd class="normal|trouble">` と `<p>` が状況を持っている。関東エリアの
 * 一覧（`/diainfo/area/4`）からは路線名と id の対応が取れる。
 *
 * HTML の形が変わればここが壊れる。壊れたときは `parseStatus` が null を返すので、
 * 画面には前回値と「取得できず」が出る（README 参照）。
 */

/** 1 路線の運行状況。 */
export type LineStatus = {
  /** 路線名（設定に書いた名前）。 */
  readonly name: string
  /** Yahoo!路線情報の id。 */
  readonly id: string
  /** 平常運転か。 */
  readonly isNormal: boolean
  /** 表示する文。平常なら「平常運転」、異常なら状況文。 */
  readonly text: string
  /** 取れた時刻（`HH:MM`）。 */
  readonly at: string
}

/** 組み込みの路線 id。一覧が引けないときの頼み。 */
export const DEFAULT_LINE_IDS: Readonly<Record<string, string>> = {
  山手線: '21',
  東急田園都市線: '114',
}

/** 路線カラー。無い路線は灰色。 */
export const LINE_COLORS: Readonly<Record<string, string>> = {
  山手線: '#9ACD32',
  東急田園都市線: '#20A288',
}

/** 路線カラー（既定は灰）。 */
export function lineColorOf(name: string): string {
  return LINE_COLORS[name] ?? '#8A8A8A'
}

/** 運行情報のページ。 */
export function diainfoUrl(id: string): string {
  return `https://transit.yahoo.co.jp/diainfo/${id}/0`
}

/** 関東エリアの路線一覧。 */
export const AREA_URL = 'https://transit.yahoo.co.jp/diainfo/area/4'

/** よくあるブラウザの名乗り。付けないと弾かれることがある。 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** タグを落として実体参照を戻し、空白を 1 つに均す。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 運行情報のページから状況を読む。読めなければ null。
 *
 * @param html ページの HTML
 */
export function parseStatus(html: string): { isNormal: boolean; text: string } | null {
  const block = /id="mdServiceStatus"[\s\S]{0,4000}?<\/dl>/.exec(html)?.[0]

  if (block === undefined) {
    return null
  }

  const kind = /<dd class="([a-z]+)"/.exec(block)?.[1] ?? ''
  const body = /<dd[^>]*>([\s\S]*?)<\/dd>/.exec(block)?.[1] ?? ''
  const heading = textOf(/<dt[^>]*>([\s\S]*?)<\/dt>/.exec(block)?.[1] ?? '')
  const isNormal = kind === 'normal' || heading.includes('平常運転')
  const detail = textOf(body)

  if (isNormal) {
    return { isNormal: true, text: heading === '' ? '平常運転' : heading }
  }

  return detail === '' ? null : { isNormal: false, text: detail }
}

/**
 * エリア一覧から路線名 → id を読む。
 *
 * @param html 一覧ページの HTML
 */
export function parseAreaLines(html: string): Record<string, string> {
  const found: Record<string, string> = {}

  for (const [, id = '', name = ''] of html.matchAll(
    /href="\/diainfo\/(\d+)\/0"[^>]*>([^<]+)</g,
  )) {
    const trimmed = textOf(name)

    if (trimmed !== '' && found[trimmed] === undefined) {
      found[trimmed] = id
    }
  }

  return found
}

/**
 * 路線名から id を引く。一覧に無ければ組み込みの表、それにも無ければ null。
 *
 * @param name 路線名
 * @param area 一覧から読んだ表
 */
export function lineIdOf(name: string, area: Readonly<Record<string, string>>): string | null {
  return area[name] ?? DEFAULT_LINE_IDS[name] ?? null
}

/**
 * 平常 ↔ 異常が入れ替わった路線を拾う。
 *
 * 初めて取れたときは「変化」として扱わない（起動直後にまとめて鳴らさないため）。
 *
 * @param before 前回の状況
 * @param after 今回の状況
 */
export function changedLines(
  before: readonly LineStatus[],
  after: readonly LineStatus[],
): LineStatus[] {
  const was = new Map(before.map(line => [line.name, line.isNormal]))

  return after.filter(line => {
    const previous = was.get(line.name)

    return previous !== undefined && previous !== line.isNormal
  })
}

/** 設定の「山手線,東急田園都市線」を名前の並びにする。 */
export function linesOf(setting: string): string[] {
  return setting
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
    .slice(0, 6)
}
