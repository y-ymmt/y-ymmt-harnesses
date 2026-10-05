import { describe, expect, test, tier } from 'claude-code/testing'

import {
  DEFAULT_LINE_IDS,
  changedLines,
  diainfoUrl,
  lineColorOf,
  lineIdOf,
  linesOf,
  parseAreaLines,
  parseStatus,
} from '../hooks/transit'
import type { LineStatus } from '../hooks/transit'

tier('user')

/** 実物のページから切り出した、平常運転の塊。 */
const NORMAL =
  '<div id="mdServiceStatus"><dl><dt><span class="icnNormalLarge"></span>平常運転</dt>' +
  '<dd class="normal"><p>現在､事故･遅延に関する情報はありません。</p></dd></dl></div>'

/** 実物のページから切り出した、運転状況の塊。 */
const TROUBLE =
  '<div id="mdServiceStatus"><dl><dt><span class="icnAlertLarge"></span>運転状況</dt>' +
  '<dd class="trouble"><p>車両故障の影響で、一部列車に遅れや運休が出ています。' +
  '<span>（9月16日 10時30分掲載）</span></p></dd></dl></div>'

/** 路線一覧の一部。 */
const AREA =
  '<li><a href="/diainfo/21/0">山手線</a></li>' +
  '<li><a href="/diainfo/114/0">東急田園都市線</a></li>' +
  '<li><a href="/diainfo/28/0">中央線快速</a></li>'

function statusOf(name: string, isNormal: boolean, text = ''): LineStatus {
  return { name, id: '1', isNormal, text, at: '10:40' }
}

describe('transit', () => {
  test('平常運転のページから「平常運転」を読む', () => {
    expect(parseStatus(NORMAL)).toEqual({ isNormal: true, text: '平常運転' })
  })

  test('運転状況のページから状況文を読む', () => {
    const status = parseStatus(TROUBLE)

    expect(status?.isNormal).toBe(false)
    expect(status?.text).toContain('車両故障の影響で、一部列車に遅れや運休が出ています。')
    expect(status?.text, '掲載日時も残す').toContain('（9月16日 10時30分掲載）')
    expect(status?.text, 'タグは落とす').not.toContain('<')
  })

  test('読めない HTML では null を返す（前回値を出すため）', () => {
    expect(parseStatus('<html><body>ページが変わりました</body></html>')).toBeNull()
    expect(parseStatus('')).toBeNull()
  })

  test('エリア一覧から路線名と id の対応を読む', () => {
    const area = parseAreaLines(AREA)

    expect(area['山手線']).toBe('21')
    expect(area['東急田園都市線']).toBe('114')
    expect(area['中央線快速']).toBe('28')

    expect(lineIdOf('山手線', area)).toBe('21')
    expect(lineIdOf('山手線', {}), '一覧が引けなければ組み込みの表').toBe('21')
    expect(lineIdOf('東急田園都市線', {})).toBe('114')
    expect(lineIdOf('知らない線', {}), '分からなければ null').toBeNull()
    expect(DEFAULT_LINE_IDS['山手線']).toBe('21')
  })

  test('平常 ↔ 異常が入れ替わった路線だけ拾う', () => {
    const before = [statusOf('山手線', true), statusOf('東急田園都市線', true)]
    const after = [statusOf('山手線', true), statusOf('東急田園都市線', false, '遅れ')]

    expect(changedLines(before, after).map(line => line.name)).toEqual(['東急田園都市線'])
    expect(changedLines(after, after), '同じなら何も鳴らない').toEqual([])
    expect(changedLines([], after), '初めて取れたときは鳴らさない').toEqual([])
  })

  test('設定の並びと、路線の色とページ', () => {
    expect(linesOf('山手線, 東急田園都市線 ,')).toEqual(['山手線', '東急田園都市線'])
    expect(linesOf('')).toEqual([])
    expect(linesOf('a,b,c,d,e,f,g,h'), '多くても 6 本まで').toHaveLength(6)
    expect(lineColorOf('山手線')).toBe('#9ACD32')
    expect(lineColorOf('知らない線'), '知らない路線は灰').toBe('#8A8A8A')
    expect(diainfoUrl('21')).toBe('https://transit.yahoo.co.jp/diainfo/21/0')
  })
})
