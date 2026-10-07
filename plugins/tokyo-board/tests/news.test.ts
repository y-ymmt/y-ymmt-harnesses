import { expect, test, tier } from 'claude-code/testing'

import { displayWidth } from '../hooks/board'
import { DEFAULT_NEWS_FEEDS, NEWS_SEPARATOR, isNhkSite, marqueeRunsOf, newsLineOf, parseFeedSpecs } from '../hooks/news'

tier('user')

test('既定の配信元は 3 つ（AI+ / IT / NHK）', () => {
  expect(parseFeedSpecs(DEFAULT_NEWS_FEEDS).map(feed => feed.label)).toEqual(['AI+', 'IT', 'NHK'])
})

test('isNhkSite は NHK のサイトそのもの（news.web.nhk）の URL だけ真', () => {
  expect(isNhkSite('https://news.web.nhk/n-data/conf/na/rss/cat0.xml')).toBe(true)
  expect(isNhkSite(parseFeedSpecs(DEFAULT_NEWS_FEEDS)[2]?.url ?? '')).toBe(false)
  expect(isNhkSite('https://example.com/?q=site:news.web.nhk')).toBe(false)
  expect(isNhkSite('not a url')).toBe(false)
})

test('流れる行のボタンは見出しの字だけで、区切りの　◆　はどの見出しにも入らない', () => {
  const line = newsLineOf([
    { label: 'AI+', title: 'あ', link: 'https://example.com/a' },
    { label: 'IT', title: 'い', link: 'https://example.com/b' },
  ])
  const runs = marqueeRunsOf(line, displayWidth(line.text), displayWidth(line.text))
  expect(runs.map(run => [run.text, run.href])).toEqual([
    ['[AI+] あ', 'https://example.com/a'],
    [NEWS_SEPARATOR, null],
    ['[IT] い', 'https://example.com/b'],
  ])
})
