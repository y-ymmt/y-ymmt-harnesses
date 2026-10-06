// 台本を 1 本動かして録画し、GIF にする。record.sh から呼ぶ。
//   node run.mjs <plugin> <port> <出力 GIF>
//
// 録画は Chrome の screencast（画面が変わるたびに 1 コマ届く）で撮り、届いた時刻で並べる。
// Playwright の動画録画は始まりの時刻が台本の時計とずれるため使わない。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { CURSOR, H, REST, W, screenText, settle } from './lib.mjs'

const [plugin, port, gif] = process.argv.slice(2)
const { default: scene } = await import(`./scenes/${plugin}.mjs`)

const frameDir = mkdtempSync(join(tmpdir(), 'demo-frames-'))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H } })
await ctx.addInitScript(CURSOR)
const page = await ctx.newPage()
const t0 = Date.now()
const now = () => (Date.now() - t0) / 1000

/** 届いたコマ。at は t0 からの秒。 */
const frames = []
const cdp = await ctx.newCDPSession(page)
cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  const file = join(frameDir, `f${String(frames.length).padStart(5, '0')}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  // metadata.timestamp は台本の時計と基準が違うことがあるので、届いた時刻を使う
  frames.push({ file, at: now() })
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 })

await page.goto(`http://127.0.0.1:${port}`)
await page.waitForFunction(() => window.term?.buffer?.active)
await settle(page, 1500)
// 初めてのフォルダでは「このフォルダを信頼するか」を聞かれる
if ((await screenText(page)).some(l => l.includes('Yes, I trust this folder'))) {
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await settle(page, 1500)
}
await page.mouse.move(REST.x, REST.y)

// 早送りにする区間 [始め, 終わり, 速さ]
const fastParts = []
const s = {
  page,
  fast: async (speed, fn) => {
    const from = now()
    await fn()
    fastParts.push([from, now(), speed])
  },
}

// 何も打っていない入力欄を少し見せてから始める
const start = now()
await page.waitForTimeout(800)
try {
  await scene(s)
} catch (e) {
  console.error(e.message)
  await page.screenshot({ path: `${gif}.failed.png` })
  await ctx.close()
  await browser.close()
  process.exit(1)
}
const end = now()
await page.waitForTimeout(300)
await cdp.send('Page.stopScreencast')
await ctx.close()
await browser.close()

// 早送りの区間では時間を縮める。壁の時刻 → GIF の時刻
const gifTime = t => {
  let out = t - start
  for (const [a, b, speed] of fastParts) {
    if (t <= a) break
    out -= (Math.min(t, b) - a) * (1 - 1 / speed)
  }
  return out
}
// 始まりの時点で見えていたコマから、終わりまで。各コマは次のコマが来るまで出す
const firstIndex = Math.max(0, frames.findLastIndex(f => f.at <= start))
const used = frames.slice(firstIndex).filter(f => f.at <= end)
const list = used.map((f, i) => {
  const from = Math.max(0, gifTime(Math.max(f.at, start)))
  const to = gifTime(i + 1 < used.length ? used[i + 1].at : end)
  return `file '${f.file}'\nduration ${Math.max(0.001, to - from).toFixed(3)}`
})
// concat は最後のコマの duration を使わないので、同じコマをもう一度並べ、長さは -t で切る
list.push(`file '${used.at(-1).file}'`)
const listFile = join(frameDir, 'list.txt')
writeFileSync(listFile, list.join('\n') + '\n')
const filter = [
  'fps=12,scale=960:-1:flags=lanczos,split[a][b]',
  '[a]palettegen=max_colors=128:stats_mode=diff[p]',
  '[b][p]paletteuse=dither=none:diff_mode=rectangle',
].join(';')
const tmpGif = `${gif}.tmp.gif`
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-filter_complex', filter, '-t', gifTime(end).toFixed(3), tmpGif], { stdio: 'inherit' })
renameSync(tmpGif, gif)
rmSync(frameDir, { recursive: true, force: true })
console.log(`${gif}  ${gifTime(end).toFixed(1)}s (${used.length} frames)`)
