/**
 * ニュースの見出し（RSS 2.0 と Atom）。
 *
 * 複数の配信元から見出しを取り、配信元ごとのキーワードで絞り、重複を落として
 * 交互に並べ、掲示板のいちばん下の行に流す。
 *
 * 配信元は設定 `newsFeeds` に `;` 区切りで並べる。1 つは
 * `ラベル|URL|キーワード,キーワード,…`。キーワードは省略でき、省略すれば全部通す。
 */

import { charWidth, displayWidth } from './board'

/** 昔の NHK の配信元。NHK のサイトそのもの（`news.web.nhk`）の配信元が取れないときに使う。 */
export const NEWS_URL_FALLBACK = 'https://www.nhk.or.jp/rss/news/cat0.xml'

/**
 * その URL が NHK のサイトそのもの（ホストが `news.web.nhk`）か。
 * Google ニュースの検索 URL のように、クエリに `site:news.web.nhk` を含むだけのものは偽。
 *
 * @param url 配信元の URL
 */
export function isNhkSite(url: string): boolean {
  try {
    return new URL(url).hostname === 'news.web.nhk'
  } catch {
    return false
  }
}

/** 見出しの区切り。 */
export const NEWS_SEPARATOR = '　◆　'

/** 既定の配信元（ITmedia AI＋ / ITmedia NEWS / NHK の IT 系）。plugin.json の `newsFeeds.default` と同じ（tests/news.test.ts で確かめる）。 */
export const DEFAULT_NEWS_FEEDS = [
  'AI+|https://rss.itmedia.co.jp/rss/2.0/aiplus.xml',
  'IT|https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml',
  // NHK には IT の RSS が無く、IT・ネットの一覧ページも外から読めない（内部 API が 403）。
  // Google ニュースの検索 RSS を NHK に限って使う。見出し末尾の「 - NHKニュース」は parseFeed で落とす。
  'NHK|https://news.google.com/rss/search?q=site:news.web.nhk+(AI+OR+IT+OR+%E3%82%B5%E3%82%A4%E3%83%90%E3%83%BC+OR+%E3%83%87%E3%82%B8%E3%82%BF%E3%83%AB+OR+%E5%8D%8A%E5%B0%8E%E4%BD%93+OR+%E3%83%AD%E3%83%9C%E3%83%83%E3%83%88)&hl=ja&gl=JP&ceid=JP:ja',
].join(';')

/** 配信元 1 つ。 */
export type FeedSpec = {
  /** 見出しの頭に出す短い名前（`[AI+]`）。 */
  readonly label: string
  /** RSS か Atom の URL。 */
  readonly url: string
  /** 見出しに含まれていてほしい語。空なら全部通す。 */
  readonly keywords: readonly string[]
}

/** 見出し 1 本。 */
export type NewsItem = {
  readonly label: string
  readonly title: string
  /** 記事の URL。 */
  readonly link: string
}

/** 流す 1 本の文と、どこが誰の見出しかの目印。 */
export type NewsLine = {
  /** 流す文ぜんぶ。 */
  readonly text: string
  /** 表示幅での区間（`from` 以上 `to` 未満）と、その見出しのリンク先。 */
  readonly spans: readonly { readonly from: number; readonly to: number; readonly href: string }[]
}

/** 何も無いときの値。 */
export const NO_NEWS: NewsLine = { text: '', spans: [] }

/** 実体参照と CDATA を戻す。 */
function textOf(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 1 件の塊からリンクを取る。RSS は `<link>…</link>`、Atom は `<link href="…">`。 */
function linkOf(body: string): string {
  const inline = /<link\b[^>]*>([^<]+)<\/link>/.exec(body)?.[1]

  if (inline !== undefined && inline.trim() !== '') {
    return textOf(inline)
  }

  const alternate = /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(body)?.[1]

  return textOf(alternate ?? /<link\b[^>]*href="([^"]+)"/.exec(body)?.[1] ?? '')
}

/** 配信元そのもののページ（見出しが 1 本も無いときのリンク先）。 */
function siteOf(xml: string): string {
  const first = xml.search(/<(item|entry)\b/)
  const head = first < 0 ? xml : xml.slice(0, first)

  return linkOf(head)
}

/**
 * RSS 2.0 か Atom から見出しを読む。
 *
 * `<channel>` / `<feed>` 直下の `<title>`（配信元の名前）は取らない。
 * `<item>` と `<entry>` の中だけ見る。
 *
 * @param xml フィードの中身
 */
export function parseFeed(xml: string): { readonly site: string; readonly items: NewsItem[] } {
  const items: NewsItem[] = []
  const isGoogleNews = /<link>\s*https:\/\/news\.google\.com\//.test(xml)

  for (const [, , body = ''] of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const raw = textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '')
    const title = isGoogleNews ? withoutSourceSuffix(raw) : raw
    const link = linkOf(body)

    if (title !== '') {
      items.push({ label: '', title, link })
    }
  }

  return { site: siteOf(xml), items }
}

/**
 * Google ニュースの RSS は見出しの末尾に ` - 配信元名` を付ける。それを落とす。
 * `|` で副題が続く形（`見出し | NHKニュース | タグ - NHKニュース`）も先頭だけ残す。
 */
export function withoutSourceSuffix(title: string): string {
  const cut = title.replace(/\s+-\s+[^-]{1,40}$/, '')
  const head = cut.split(/\s+\|\s+/)[0] ?? cut

  return head.trim() === '' ? title : head.trim()
}

/**
 * 設定の文字列を配信元の並びにする。
 *
 * `ラベル|URL|キーワード,…` を `;` で区切って並べる。URL だけ書いてあるときは
 * ラベルを `NEWS` にする（旧 `newsFeed` との互換）。
 *
 * @param setting 設定 `newsFeeds` の値
 */
export function parseFeedSpecs(setting: string): FeedSpec[] {
  const feeds: FeedSpec[] = []

  for (const chunk of setting.split(';')) {
    const parts = chunk.split('|').map(part => part.trim())

    if (parts.length === 0 || chunk.trim() === '') {
      continue
    }

    const onlyUrl = parts.length === 1 && (parts[0] ?? '').startsWith('http')
    const label = onlyUrl ? 'NEWS' : (parts[0] ?? '')
    const url = onlyUrl ? (parts[0] ?? '') : (parts[1] ?? '')

    if (!url.startsWith('http')) {
      continue
    }

    feeds.push({
      label: label === '' ? 'NEWS' : label,
      url,
      keywords: (parts[2] ?? '')
        .split(',')
        .map(word => word.trim())
        .filter(word => word !== ''),
    })
  }

  return feeds.slice(0, 8)
}

/** 見出しがキーワードに引っかかるか。大文字小文字は見ない。語が無ければ全部通す。 */
export function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) {
    return true
  }

  const lower = title.toLowerCase()

  return keywords.some(word => lower.includes(word.toLowerCase()))
}

/**
 * 配信元ごとに絞ったうえで、交互に並べて 1 本の並びにする。
 *
 * 同じ見出しは配信元をまたいで 1 本にする（ITmedia NEWS と AI＋ は重なる）。
 *
 * @param picked 配信元ごとの見出し（`feeds` と同じ順）
 * @param count 配信元 1 つあたりの上限
 */
export function interleave(picked: readonly (readonly NewsItem[])[], count: number): NewsItem[] {
  const limit = Math.max(1, Math.trunc(count))
  const seen = new Set<string>()
  const queues = picked.map(items => {
    const kept: NewsItem[] = []

    for (const item of items) {
      const key = item.title.trim()

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      kept.push(item)

      if (kept.length >= limit) {
        break
      }
    }

    return kept
  })

  const out: NewsItem[] = []

  for (let round = 0; round < limit; round += 1) {
    for (const queue of queues) {
      const item = queue[round]

      if (item !== undefined) {
        out.push(item)
      }
    }
  }

  return out
}

/**
 * 流す 1 本の文と、どこが誰の見出しかを作る。
 *
 * 区切りは直前の見出しの区間に含める（区切りの上に居てもリンクが外れないように）。
 *
 * @param items 並べ終えた見出し
 */
export function newsLineOf(items: readonly NewsItem[]): NewsLine {
  const parts = items.map(item => `[${item.label}] ${item.title}`)
  const text = parts.join(NEWS_SEPARATOR)
  const spans: { from: number; to: number; href: string }[] = []
  let at = 0

  parts.forEach((part, index) => {
    const from = at
    const own = displayWidth(part)
    const gap = index === parts.length - 1 ? 0 : displayWidth(NEWS_SEPARATOR)

    spans.push({ from, to: from + own + gap, href: items[index]?.link ?? '' })
    at = from + own + gap
  })

  return { text, spans }
}

/** 流れる行の 1 断片。同じ見出しのあいだは 1 つにまとめる。 */
export type MarqueeRun = {
  readonly text: string
  /** その断片が属する見出しの記事 URL。空白の断片は null。 */
  readonly href: string | null
}

/** 表示幅での位置が、どの見出しの中か。 */
function hrefAt(spans: NewsLine['spans'], at: number): string | null {
  return spans.find(part => at >= part.from && at < part.to)?.href ?? null
}

/**
 * 流れる行を、見出しごとの断片に切って返す。
 *
 * 位置の決め方は `marqueeOf` と同じ（文の左端が窓座標 `window - step`、周期は
 * 文の幅 ＋ 窓の幅）。断片の字をつなぐと `marqueeOf` の返す文とちょうど同じに
 * なるので、窓の桁は変わらない。区切り（`　◆　`）は直前の見出しに含める
 * （`newsLineOf` が span をそう作っている）。
 *
 * 窓の端に半分だけかかる全角は、`marqueeOf` と同じく空白に置き換える。その空白は
 * どの見出しにも属さないので `href` は null。
 *
 * @param line 流している文
 * @param window 窓の幅（セル）
 * @param step マーキーを進めた回数
 */
export function marqueeRunsOf(line: NewsLine, window: number, step: number): MarqueeRun[] {
  const room = Math.max(1, Math.trunc(window))
  const span = displayWidth(line.text)
  const cells: string[] = Array.from({ length: room }, () => ' ')
  const hrefs: (string | null)[] = Array.from({ length: room }, () => null)

  if (span > 0) {
    const period = span + room
    const start = ((Math.trunc(step) % period) + period) % period
    let at = room - start
    let offset = 0

    for (const character of line.text) {
      const size = charWidth(character.codePointAt(0) ?? 0)

      if (at + size > 0 && at < room) {
        if (at >= 0 && at + size <= room) {
          const href = hrefAt(line.spans, offset)

          cells[at] = character
          hrefs[at] = href

          for (let i = 1; i < size; i += 1) {
            cells[at + i] = ''
            hrefs[at + i] = href
          }
        } else {
          // 端にかかる全角は出さない（桁がずれるため）。
          for (let i = 0; i < size; i += 1) {
            if (at + i >= 0 && at + i < room) {
              cells[at + i] = ' '
              hrefs[at + i] = null
            }
          }
        }
      }

      at += size
      offset += size
    }
  }

  const runs: MarqueeRun[] = []

  for (let i = 0; i < room; i += 1) {
    const last = runs[runs.length - 1]
    const href = hrefs[i] ?? null

    if (last !== undefined && last.href === href) {
      runs[runs.length - 1] = { text: `${last.text}${cells[i] ?? ''}`, href }
      continue
    }

    runs.push({ text: cells[i] ?? ' ', href })
  }

  return runs
}
