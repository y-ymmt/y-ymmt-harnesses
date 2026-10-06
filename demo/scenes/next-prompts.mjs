// 返事のあとに「次の一手」の候補が並び、/1 と空白で 1 つ目を入力欄に入れる。
import { ask, typeSlow, waitText } from '../lib.mjs'

export default async function (s) {
  await ask(s, 'src/routes/users.js を読んで、何をしているか一行で教えて')
  await s.fast(3, () => waitText(s.page, '次の一手:'))
  await s.fast(3, async () => {
    // 候補を考え中の表示が消え、ボタンが並ぶまで
    const { waitFor } = await import('../lib.mjs')
    await waitFor(s.page, lines => lines.some(l => l.includes('次の一手:') && l.includes('[')))
  })
  await s.page.waitForTimeout(2200)
  await typeSlow(s.page, '/1', 250)
  await s.page.waitForTimeout(500)
  await s.page.keyboard.type(' ')
  await s.page.waitForTimeout(3000)
}
