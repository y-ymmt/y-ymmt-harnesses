// 表のコピーボタンと、返事まるごとコピーのボタン。コピーした中身は入力欄に貼って見せる
// （Claude Code は長い貼り付けを畳むので、もう一度貼って開く）。
import { REST, ask, clickAt, hoverAt, locate, pasteClipboard, waitText } from '../lib.mjs'

async function copyAndPaste(s, label) {
  await clickAt(s.page, await locate(s.page, label))
  await s.page.waitForTimeout(1800)
  await hoverAt(s.page, REST)
  await pasteClipboard(s.page)
  await waitText(s.page, 'Pasted text', 5000)
  await s.page.waitForTimeout(1200)
  await pasteClipboard(s.page)
  await s.page.waitForTimeout(3000)
  // 入力欄を空にする
  await s.page.keyboard.press('Control+c')
  await s.page.waitForTimeout(800)
}

export default async function (s) {
  await ask(s, '東京・大阪・名古屋の人口（万人）と面積（km²）を表にして。説明は一行', { speed: 2 })
  await s.page.waitForTimeout(800)
  await copyAndPaste(s, '⧉ Markdown')
  await copyAndPaste(s, '[ GitHub ]')
}
