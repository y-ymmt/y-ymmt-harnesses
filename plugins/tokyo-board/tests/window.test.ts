import { expect, test, tier } from 'claude-code/testing'

import { isWithin, minutesOf, periodStartOf, windowOf } from '../hooks/window'

tier('user')

/** 今日のローカル時刻 HH:MM のミリ秒。 */
const at = (hh: number, mm: number): number => new Date(2026, 9, 5, hh, mm, 0).getTime()

test('HH:MM を分に読む', () => {
  expect(minutesOf('17:00')).toBe(1020)
  expect(minutesOf(' 9:05 ')).toBe(545)
  expect(minutesOf('24:00')).toBe(1440)
  expect(minutesOf('24:30')).toBeNull()
  expect(minutesOf('25:00')).toBeNull()
  expect(minutesOf('17:60')).toBeNull()
  expect(minutesOf('')).toBeNull()
  expect(minutesOf('夕方')).toBeNull()
})

test('17:00〜24:00 の間だけ開く（始まりは含み、終わりは含まない）', () => {
  const w = windowOf('17:00', '24:00')
  expect(isWithin(w, at(16, 59))).toBe(false)
  expect(isWithin(w, at(17, 0))).toBe(true)
  expect(isWithin(w, at(20, 30))).toBe(true)
  expect(isWithin(w, at(23, 59))).toBe(true)
  expect(isWithin(w, at(0, 0))).toBe(false)
  expect(isWithin(w, at(9, 0))).toBe(false)
})

test('日をまたぐ時間帯', () => {
  const w = windowOf('22:00', '06:00')
  expect(isWithin(w, at(21, 59))).toBe(false)
  expect(isWithin(w, at(22, 0))).toBe(true)
  expect(isWithin(w, at(2, 0))).toBe(true)
  expect(isWithin(w, at(5, 59))).toBe(true)
  expect(isWithin(w, at(6, 0))).toBe(false)
})

test('読めない・同じ時刻なら終日出す', () => {
  expect(windowOf('', '24:00')).toBeNull()
  expect(windowOf('17:00', 'x')).toBeNull()
  expect(windowOf('00:00', '24:00')).toBeNull()
  expect(windowOf('09:00', '09:00')).toBeNull()
  expect(isWithin(null, at(3, 0))).toBe(true)
})

test('回の始まり: 中なら直近に開いた時刻、外なら直近に閉じた時刻', () => {
  const w = windowOf('17:00', '24:00')
  expect(periodStartOf(w, at(18, 0)), 'きょう 17:00 から').toBe(at(17, 0))
  expect(periodStartOf(w, at(23, 59))).toBe(at(17, 0))
  expect(periodStartOf(w, at(17, 0)), '開いたちょうど').toBe(at(17, 0))
  expect(periodStartOf(w, at(11, 0)), 'きのうの 24:00（＝きょう 0:00）から').toBe(at(0, 0))
  expect(periodStartOf(w, at(0, 0))).toBe(at(0, 0))
  expect(periodStartOf(w, new Date(2026, 9, 4, 20, 0).getTime()), 'きのうの夜は別の回').toBe(new Date(2026, 9, 4, 17, 0).getTime())

  const night = windowOf('22:00', '06:00')
  expect(periodStartOf(night, at(2, 0)), '日をまたぐ: きのうの 22:00 から').toBe(new Date(2026, 9, 4, 22, 0).getTime())
  expect(periodStartOf(night, at(12, 0)), 'きょうの 6:00 から').toBe(at(6, 0))
  expect(periodStartOf(night, at(23, 0))).toBe(at(22, 0))

  expect(periodStartOf(null, at(3, 0)), '終日なら回は 1 つ').toBe(0)
})
