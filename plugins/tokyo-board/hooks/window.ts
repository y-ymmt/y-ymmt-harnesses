/**
 * ボードを出す時間帯（設定 `showFrom` / `showUntil`）。
 *
 * 時刻はこの PC の時計（ローカル時刻）で見る。`24:00` は一日の終わり（翌 0:00 の手前）。
 * 始まりが終わりより遅い（`22:00`〜`06:00` など）ときは日をまたぐ帯として扱う。
 * どちらかが空か読めないときは、時間帯で絞らない（いつでも出す）。
 */

/** 一日の分。 */
const DAY_MINUTES = 24 * 60

/** 出す時間帯（分。0〜1440）。null は「いつでも」。 */
export type ShowWindow = { readonly from: number; readonly until: number } | null

/**
 * `HH:MM` を一日の何分目かに読む。`24:00` は 1440。読めなければ null。
 *
 * @param text `17:00` のような文字列
 */
export function minutesOf(text: string): number | null {
  const matched = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)

  if (matched === null) {
    return null
  }

  const hours = Number(matched[1])
  const minutes = Number(matched[2])

  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) {
    return null
  }

  return hours * 60 + minutes
}

/**
 * 設定 2 つから時間帯を作る。始まりと終わりが同じなら「いつでも」。
 *
 * @param from 設定 `showFrom`
 * @param until 設定 `showUntil`
 */
export function windowOf(from: string, until: string): ShowWindow {
  const start = minutesOf(from)
  const end = minutesOf(until)

  if (start === null || end === null || start % DAY_MINUTES === end % DAY_MINUTES) {
    return null
  }

  return { from: start, until: end }
}

/**
 * その時刻が時間帯の中か。始まりは含み、終わりは含まない。
 *
 * @param window 時間帯（null はいつでも）
 * @param nowMs 今（ミリ秒）
 */
export function isWithin(window: ShowWindow, nowMs: number): boolean {
  if (window === null) {
    return true
  }

  const at = new Date(nowMs)
  const minute = at.getHours() * 60 + at.getMinutes()

  return window.from < window.until
    ? minute >= window.from && minute < window.until
    : minute >= window.from || minute < window.until
}

/**
 * 今が入っている「回」の始まり（ミリ秒）。時間帯の中なら直近に開いた時刻、外なら直近に閉じた時刻。
 *
 * ボタンで決めた表示を、同じ回のあいだだけ覚えておくための目印に使う
 * （17:00〜24:00 なら、きょう 18 時と 20 時は同じ回、きのうの 20 時やきょうの 11 時は別の回）。
 * 時間帯が「いつでも」なら回は 1 つだけなので 0。
 *
 * @param window 時間帯（null はいつでも）
 * @param nowMs 今（ミリ秒）
 */
export function periodStartOf(window: ShowWindow, nowMs: number): number {
  if (window === null) {
    return 0
  }

  const at = new Date(nowMs)
  let latest = Number.NEGATIVE_INFINITY

  // 境目（開く・閉じる）は日に 2 つ。きのうときょうのぶんを並べ、今より前でいちばん新しいものを取る。
  // `new Date(年, 月, 日, 0, 分)` で組むので、24:00（1440 分）は翌日の 0:00 になる。
  for (const dayOffset of [-1, 0]) {
    for (const minute of [window.from, window.until]) {
      const edge = new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset, 0, minute).getTime()

      if (edge <= nowMs && edge > latest) {
        latest = edge
      }
    }
  }

  return latest
}
