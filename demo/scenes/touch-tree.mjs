// Claude が読んだ・編集したファイルが、リポジトリのツリーに沿ってペインに並ぶ。
import { REST, ask, clickAt, hoverAt, locate, waitText } from '../lib.mjs'

export default async function (s) {
  // 先にペインを開いておき、ツリーが育つところを見せる
  await waitText(s.page, 'touch-tree を開く', 10000)
  await clickAt(s.page, await locate(s.page, 'touch-tree を開く'))
  await s.page.waitForTimeout(1200)
  await hoverAt(s.page, REST)
  await ask(s, 'src と tests を読んで、greet に名前が空のときの既定値を足し、テストも足して', { speed: 3 })
  await s.page.waitForTimeout(3500)
}
