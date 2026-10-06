// 作業中のスピナーが、このセッションの何ターン目かに変わる。
import { ask } from '../lib.mjs'

export default async function (s) {
  // スピナーを見せたいので早送りしない
  await ask(s, 'src/greet.js を読んで一言で説明して', { speed: 1, quiet: 1200 })
  await ask(s, 'src/routes の中のファイルを読んで、それぞれ一言で説明して', { speed: 1, quiet: 1200 })
  await s.page.waitForTimeout(1500)
}
