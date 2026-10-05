import { expect, test, tier } from 'claude-code/testing'

import { DEFAULT_NEWS_FEEDS, isNhkSite, parseFeedSpecs } from '../hooks/news'

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
