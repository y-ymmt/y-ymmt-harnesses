// 表の返事を、見出しの ⇅ で並べ替える。
import { REST, ask, clickAt, hoverAt, locate, screenText } from '../lib.mjs'

/** 見出し label のすぐ右にある並べ替えの印（⇅ ▲ ▼ のどれか）。 */
async function sortButton(page, label) {
  const line = (await screenText(page)).find(l => /[⇅▲▼]/.test(l) && l.includes(label)) ?? ''
  const glyph = line.slice(line.indexOf(label)).match(/[⇅▲▼]/)?.[0]
  return glyph ? locate(page, glyph, { after: label }) : null
}

export default async function (s) {
  await ask(s, '東京・大阪・名古屋・福岡・札幌の人口（万人）と面積（km²）を表にして。数字だけで、説明は一行', { speed: 2 })
  await s.page.waitForTimeout(800)
  for (const label of ['人口', '人口', '面積']) {
    const button = await sortButton(s.page, label)
    if (!button) throw new Error(`no sort button for ${label}`)
    await clickAt(s.page, button)
    await s.page.waitForTimeout(1700)
  }
  await hoverAt(s.page, REST)
  await s.page.waitForTimeout(1500)
}
