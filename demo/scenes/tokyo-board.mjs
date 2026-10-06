// プロンプトの上に、東京の天気と電光掲示板風の運行情報・ニュースが出る。
import { waitText } from '../lib.mjs'

export default async function (s) {
  // 天気と運行情報を取りに行くので、出そろうまで待つ（早送り）
  await s.fast(4, async () => {
    await waitText(s.page, '°C', 30000)
    await s.page.waitForTimeout(2000)
  })
  // 掲示板とニュースが流れるところを見せる
  await s.page.waitForTimeout(9000)
}
