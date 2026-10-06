// 台本（scenes/*.mjs）から使う道具。ttyd が映すターミナル（xterm.js）を Playwright で操作する。

export const W = 1100
export const H = 680
/** マウスを置いておく場所（画面の右下）。 */
export const REST = { x: W - 80, y: H - 140 }

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

/** 録画には OS のマウスカーソルが映らないので、ページ内に描いた矢印をマウスに合わせて動かし、押したら波紋を出す。 */
export const CURSOR = () => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div')
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 99999, pointerEvents: 'none', transform: 'translate(-3px,-2px)' })
    document.body.appendChild(c)
    addEventListener('mousemove', e => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px` }, true)
    addEventListener('mousedown', e => {
      const r = document.createElement('div')
      Object.assign(r.style, { position: 'fixed', left: `${e.clientX - 14}px`, top: `${e.clientY - 14}px`, width: '28px', height: '28px', borderRadius: '50%', border: '3px solid #ffd166', zIndex: 99998, pointerEvents: 'none', transition: 'all .45s ease-out', opacity: 1 })
      document.body.appendChild(r)
      requestAnimationFrame(() => Object.assign(r.style, { transform: 'scale(1.8)', opacity: 0 }))
      setTimeout(() => r.remove(), 600)
    }, true)
  })
}

/** 画面に見えている行（全角も 1 文字として返る）。 */
export const screenText = page => page.evaluate(() => {
  const b = window.term.buffer.active
  const out = []
  for (let y = 0; y < window.term.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return out
})

/** 行 y の x 文字目のセルの中心（ページの座標）。全角は 2 セルぶん数える。 */
async function cellCenter(page, line, x, y) {
  const cell = await page.evaluate(() => {
    const d = window.term._core._renderService.dimensions.css.cell
    const r = window.term.element.querySelector('.xterm-screen').getBoundingClientRect()
    return { w: d.width, h: d.height, left: r.left, top: r.top }
  })
  let col = 0
  for (const ch of line.slice(0, x)) col += WIDE.test(ch) ? 2 : 1
  return { x: cell.left + (col + 0.5) * cell.w, y: cell.top + (y + 0.5) * cell.h }
}

/** 画面の y 行目・x 文字目のセルの中心。 */
export async function cellAt(page, x, y) {
  const lines = await screenText(page)
  return cellCenter(page, lines[y] ?? '', x, y)
}

/**
 * 画面で text が出る位置。`nth` 番目（0 から）、`after` を渡すとその文字列より右だけを探す。
 * 見つからなければ null。
 */
export async function locate(page, text, { nth = 0, after, center = true } = {}) {
  const lines = await screenText(page)
  const hits = []
  lines.forEach((l, y) => {
    const from = after === undefined ? 0 : l.indexOf(after)
    if (from < 0) return
    let i = from - 1
    while ((i = l.indexOf(text, i + 1)) !== -1) hits.push({ x: i, y })
  })
  const hit = hits[nth]
  if (!hit) return null
  const line = lines[hit.y]
  // ラベルの真ん中を押す
  const mid = center ? hit.x + Math.floor([...text].length / 2) : hit.x
  return cellCenter(page, line, mid, hit.y)
}

/** 画面の行が pred を満たすまで待つ。 */
export async function waitFor(page, pred, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (pred(await screenText(page))) return
    await page.waitForTimeout(300)
  }
  throw new Error(`timeout\n${(await screenText(page)).join('\n')}`)
}

export const waitText = (page, text, timeout) => waitFor(page, lines => lines.some(l => l.includes(text)), timeout)

/** 画面が ms のあいだ変わらなくなるまで待つ。 */
export async function settle(page, ms = 2000, timeout = 120000) {
  const end = Date.now() + timeout
  let last = ''
  let since = Date.now()
  while (Date.now() < end) {
    const now = (await screenText(page)).join('\n')
    if (now !== last) { last = now; since = Date.now() } else if (Date.now() - since >= ms) return
    await page.waitForTimeout(200)
  }
}

/** 1 文字ずつ打つ（打っている様子を見せる）。 */
export async function typeSlow(page, text, delay = 35) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await page.waitForTimeout(delay)
  }
}

/** なめらかに動かしてから押す。 */
export async function clickAt(page, pos) {
  await page.mouse.move(pos.x, pos.y, { steps: 25 })
  await page.waitForTimeout(350)
  await page.mouse.click(pos.x, pos.y)
}

export async function hoverAt(page, pos) {
  await page.mouse.move(pos.x, pos.y, { steps: 25 })
}

/** ターンの終わりに出る `✻ Churned for 6s` の行。 */
const DONE = /^\s*\S\s+\S+ for \d+(?:\.\d+)?(?:ms|s|m)\b/
const doneCount = lines => lines.filter(l => DONE.test(l)).length

/** 依頼を打って送り、返事が出そろうまで待つ。待っている間は GIF で早送りにする。 */
export async function ask(s, text, { speed = 4, quiet = 2000 } = {}) {
  await typeSlow(s.page, text)
  await s.page.waitForTimeout(400)
  const before = doneCount(await screenText(s.page))
  await s.page.keyboard.press('Enter')
  await s.fast(speed, async () => {
    await waitFor(s.page, lines => doneCount(lines) > before)
    await settle(s.page, quiet)
  })
}
