// ボタンを「ボタンだと一目で分かる」ようにする下地。Button 自身には背景色の指定が無い（文字のスタイルと hover だけ）ので、
// Box で包んで背景を塗る。ホバーのときの見た目（端末が文字の前景と背景を反転させる）とは別物なので、押せる所に乗せると反転が目立つ。
// 色はテーマの `tableRule`（表の罫線の色。`rule` より一段濃い）にする。`rule` では薄くてボタンだと分かりにくかった。
// `mono` など `rule` が無いテーマは、Claude Code 本体のテーマの色（`userMessageBackground`）にする（暗い・明るいの両方に合わせてある）。
import type { ElementTable, RenderElement } from 'claude-code'

import type { Style } from './theme'

export const FALLBACK_CHIP_BACK = 'userMessageBackground'

export const chipBack = (style: Style): string => style.theme.tableRule ?? style.theme.rule ?? FALLBACK_CHIP_BACK

/** ボタン（や、押せる文字）に常時の背景を敷く。key は Button 自身のものと別（`<key>.chip`）にする。 */
export const chip = (el: ElementTable, style: Style, key: string, button: RenderElement): RenderElement => {
  const { Box } = el
  return (
    <Box key={`${key}.chip`} flexShrink={0} backgroundColor={chipBack(style)}>
      {button}
    </Box>
  )
}
