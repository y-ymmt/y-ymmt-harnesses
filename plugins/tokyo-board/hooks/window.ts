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
