// reply-prism: 本家 render.tsx にあった表示幅の計算を、表のコピー（Slack 用の桁揃え）からも
// 使えるように切り出したもの。中身は本家と同じ。

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : undefined

export const width = (s: string): number => {
  const graphemes = segmenter ? [...segmenter.segment(s)].map(g => g.segment) : [...s]
  return graphemes.reduce((w, g) => (/^\p{M}+$/u.test(g) ? w : w + (WIDE.test(g) ? 2 : 1)), 0)
}
