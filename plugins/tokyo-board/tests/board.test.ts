import { describe, expect, test, tier } from 'claude-code/testing'

import {
  BOARD_ROWS,
  PANEL_ROWS,
  PANEL_WIDTH,
  bigDigits,
  displayWidth,
  marqueeOf,
  padTo,
  transitBoard,
  weatherPanel,
} from '../hooks/board'
import type { LineStatus } from '../hooks/transit'
import { amedasSlotOf, amedasUrl, latestOf, officeOf, skyOf } from '../hooks/weather'

tier('user')

/** アメダスの実況（実物と同じ `[値, 品質]` の形）。 */
const AMEDAS = {
  '20260916100000': { temp: [20.8, 0], precipitation1h: [0, 0], humidity: [97, 0] },
  '20260916104000': { temp: [21.1, 0], precipitation1h: [1.5, 0], humidity: [98, 0], wind: [2.3, 0] },
  notATime: { temp: [99, 0] },
}

const LINES: LineStatus[] = [
  { name: '山手線', id: '21', isNormal: true, text: '平常運転', at: '10:40' },
  {
    name: '東急田園都市線',
    id: '114',
    isNormal: false,
    text: '車両故障の影響で、一部列車に遅れや運休が出ています。',
    at: '10:40',
  },
]

describe('board', () => {
  test('アメダスの時刻は 3 時間刻みに丸め、いちばん新しい観測を読む', () => {
    expect(amedasSlotOf('2026-09-16T10:40:00+09:00')).toEqual({ day: '20260916', hour: '09' })
    expect(amedasSlotOf('2026-09-16T00:10:00+09:00').hour).toBe('00')
    expect(amedasSlotOf('2026-09-16T23:50:00+09:00').hour).toBe('21')
    expect(amedasSlotOf('こわれた時刻')).toEqual({ day: '', hour: '' })
    expect(amedasUrl('44132', '2026-09-16T10:40:00+09:00')).toBe(
      'https://www.jma.go.jp/bosai/amedas/data/point/44132/20260916_09.json',
    )

    const latest = latestOf(AMEDAS)

    expect(latest?.temp, 'いちばん新しいキー').toBe(21.1)
    expect(latest?.precipitation).toBe(1.5)
    expect(latest?.humidity).toBe(98)
    expect(latest?.wind).toBe(2.3)
    expect(latest?.at).toBe('10:40')
    expect(latestOf({}), '空なら null').toBeNull()
  })

  test('WMO の天気コードを空模様に均す', () => {
    expect(skyOf(0)).toBe('clear')
    expect([1, 2, 3].map(skyOf)).toEqual(['cloud', 'cloud', 'cloud'])
    expect([45, 48].map(skyOf)).toEqual(['fog', 'fog'])
    expect([51, 61, 67].map(skyOf)).toEqual(['rain', 'rain', 'rain'])
    expect([71, 75, 77].map(skyOf)).toEqual(['snow', 'snow', 'snow'])
    expect([80, 82].map(skyOf)).toEqual(['shower', 'shower'])
    expect([95, 99].map(skyOf)).toEqual(['storm', 'storm'])
  })

  test('表示幅は全角を 2 と数え、そのぶんで切り詰める', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('山手線')).toBe(6)
    expect(displayWidth('山手a線')).toBe(7)
    expect(padTo('山手線', 10)).toBe('山手線    ')
    expect(displayWidth(padTo('山手線', 10))).toBe(10)
    // 長ければ切る。全角の途中で切れるぶんは空白で埋め、幅はちょうど 5 に保つ（パネルの桁が崩れないように）
    expect(padTo('車両故障の影響で', 5), '長ければ切る').toBe('車両 ')
    expect(displayWidth(padTo('車両故障の影響で', 5)), '幅はちょうど').toBe(5)
  })

  test('電光掲示板は短い文でも必ず一周する', () => {
    const width = 12
    const short = '平常運転'
    const period = displayWidth(short) + width

    const seen = Array.from({ length: period }, (_, step) => marqueeOf(short, width, step))

    for (const frame of seen) {
      expect(displayWidth(frame), `幅は常に ${width}`).toBe(width)
    }

    expect(new Set(seen).size > 1, '短文でも流れる').toBe(true)
    expect(marqueeOf(short, width, period), '一周して戻る').toBe(marqueeOf(short, width, 0))
    expect(marqueeOf(short, width, 0).trim(), '始まりは窓の外').toBe('')

    // 全角混じりの長文でも桁が崩れない
    const long = '車両故障の影響で、一部列車に遅れや運休が出ています。（9月16日 10時30分掲載）'

    for (const step of [0, 3, 17, 40, 99]) {
      expect(displayWidth(marqueeOf(long, width, step)), `step ${step}`).toBe(width)
    }
  })

  test('大きい数字は 1 文字 3 セル × 3 行', () => {
    const rows = bigDigits('21')

    expect(rows).toHaveLength(3)

    for (const row of rows) {
      expect(displayWidth(row) <= 3 * 2 + 1, `「21」で ${displayWidth(row)} セル`).toBe(true)
    }

    // 字形は横 3 × 縦 6 ドット。上下 2 ドットを半分ブロック 1 セルに詰めるので、6 ドット行が 3 セル行になる。
    // 3・5・6・8・9 の中の横棒は 3 ドット行目（真ん中のセル行の上半分）にある。
    expect(bigDigits('0'), '0 の真ん中は空く').toEqual(['█▀█', '█ █', '█▄█'])
    expect(bigDigits('8'), '8 の真ん中のセル行には上半分に横棒が入る').toEqual(['█▀█', '█▀█', '█▄█'])
    expect(bigDigits('1'), '行末の空白は落とす').toEqual(['▄█', ' █', '▄█▄'])
    expect(bigDigits('-'), '- は真ん中のセル行いっぱい').toEqual(['', '███', ''])
  })

  test('天気パネルは 26 セル幅・7 行の枠になる', () => {
    const panel = weatherPanel('rain', latestOf(AMEDAS), false, '13:09', {
      pop: 90,
      high: 22.1,
      low: 19.8,
      sunset: '17:47',
    })

    expect(panel).toHaveLength(PANEL_ROWS)

    for (const line of panel) {
      const text = line.map(run => run.text).join('')

      expect(displayWidth(text), `「${text}」`).toBe(PANEL_WIDTH)
    }

    expect(panel[0]?.map(run => run.text).join(''), '見出しに天気').toContain('東京 雨')
    expect(
      panel.map(line => line.map(run => run.text).join('')).join(''),
      '湿度と降水も出す',
    ).toContain('湿度')
    expect(
      panel[5]?.map(run => run.text).join(''),
      'いちばん下はきょうの見通し',
    ).toContain('降水90%')
  })

  test('掲示板は路線ごとに 1 行、平常は緑・異常は橙', () => {
    const rails = transitBoard(LINES, 46, 0, false)

    expect(rails, '枠 2 行 ＋ 中身 5 行').toHaveLength(BOARD_ROWS)

    const yamanote = rails[1] ?? []
    const denentoshi = rails[2] ?? []

    expect(yamanote.some(run => run.color === '#39FF14'), '平常は緑').toBe(true)
    expect(yamanote.some(run => run.color === '#9ACD32'), '山手線の色').toBe(true)
    expect(denentoshi.some(run => run.color === '#FFA500'), '異常は橙').toBe(true)
    expect(denentoshi.some(run => run.color === '#20A288'), '田園都市線の色').toBe(true)
    expect(
      yamanote.some(run => run.backgroundColor === '#111111'),
      '地は黒',
    ).toBe(true)
    expect(yamanote.map(run => run.text).join(''), '時刻は 1 行目の右端').toContain('10:40')

    // どのコマでも行の幅は変わらない
    const widthOf = (step: number): number =>
      displayWidth(
        (transitBoard(LINES, 46, step, false)[2] ?? []).map(run => run.text).join(''),
      )

    expect(new Set([0, 1, 5, 20, 77].map(widthOf)).size, '桁がずれない').toBe(1)
  })
})

describe('警報行・ニュース行', () => {
  const ALERT = {
    warnings: [{ code: '03', name: '大雨警報', severity: 'warning' as const }],
    quake: null,
  }

  test('⚠ 行は空行と入れ替わるだけで、掲示板の背は伸びない', () => {
    const plain = transitBoard(LINES, 46, 0, false, { news: 'ニュース' })
    const alerted = transitBoard(LINES, 46, 0, false, { alert: ALERT, news: 'ニュース' })

    expect(plain).toHaveLength(BOARD_ROWS)
    expect(alerted).toHaveLength(BOARD_ROWS)

    for (const rails of [plain, alerted]) {
      for (const line of rails) {
        expect(displayWidth(line.map(run => run.text).join(''))).toBe(46)
      }
    }

    expect(alerted[3]?.map(run => run.text).join(''), '警報は 3 行目に入る').toContain(
      '大雨警報',
    )
    expect(alerted[5]?.map(run => run.text).join(''), 'ニュースはいちばん下').toContain('NEWS')
    expect(
      plain.map(line => line.map(run => run.text).join('')).join(''),
      'ふだんは出ない',
    ).not.toContain('▲')
  })
})

test('区域コードから府県コード: ふつうは頭 2 桁 + 0000、北海道・鹿児島・沖縄は気象庁の表どおり', () => {
  expect(officeOf('130010')).toBe('130000')
  expect(officeOf('270000')).toBe('270000')
  expect(officeOf('016010')).toBe('016000')
  expect(officeOf('014020')).toBe('014100')
  expect(officeOf('014030')).toBe('014030')
  expect(officeOf('460010')).toBe('460100')
  expect(officeOf('460040')).toBe('460040')
  expect(officeOf('471010')).toBe('471000')
  expect(officeOf('474020')).toBe('474000')
})
