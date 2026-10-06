// 打ったプロンプトが帯の棒に並ぶ。棒にホバーしてカードを読み、[ 入力欄へ ] で打ち直す。
import { REST, ask, cellAt, clickAt, hoverAt, locate, screenText, waitFor, waitText } from '../lib.mjs'

/** 帯の棒の行で、n 番目（0 から）の棒の位置。 */
async function bar(page, n) {
  const lines = await screenText(page)
  const y = lines.findIndex(l => /^\s*[│┃]{2,}\s*$/.test(l))
  return y < 0 ? null : cellAt(page, lines[y].search(/[│┃]/) + n, y)
}

export default async function (s) {
  await ask(s, 'README.md を読んで一言で要約して', { speed: 3 })
  await ask(s, 'src/greet.js の greet で、名前が空なら "Hello, world!" を返すようにして', { speed: 3 })
  await ask(s, 'npm test を実行して結果だけ教えて', { speed: 3 })
  await s.page.waitForTimeout(800)
  for (const n of [0, 2, 1]) {
    const pos = await bar(s.page, n)
    if (!pos) throw new Error(`no bar ${n}`)
    await hoverAt(s.page, pos)
    await s.page.waitForTimeout(1600)
  }
  await waitText(s.page, '[ 入力欄へ ]', 5000)
  // 棒から真上に上げるとボタンに届く（斜めに動かすと別の棒を通ってカードが変わる）
  const from = await bar(s.page, 1)
  const button = await locate(s.page, '[ 入力欄へ ]')
  await clickAt(s.page, { x: from.x, y: button.y })
  await waitFor(s.page, lines => lines.some(l => /^❯ src\/greet\.js/.test(l)), 5000)
  await s.page.waitForTimeout(1200)
  await hoverAt(s.page, REST)
  await s.page.waitForTimeout(2500)
}
