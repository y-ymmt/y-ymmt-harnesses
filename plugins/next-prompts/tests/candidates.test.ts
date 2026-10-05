/**
 * candidates.ts（`$` に触れない部分）のテスト。`bun test` で走る。
 *
 *   bun test plugins/next-prompts/tests/
 */
import { describe, expect, test } from 'bun:test'

import {
  cellWidth,
  cleanText,
  fingerprintOf,
  isSimilar,
  KINDS,
  lastUserText,
  layoutLabels,
  mergeCandidates,
  parseCandidates,
  promptOf,
  requestCountOf,
  systemOf,
  transcriptOf,
  truncateLabel,
  uniqueCandidates,
  TRANSCRIPT_BUDGET,
} from '../hooks/candidates'
import type { Message } from '../hooks/candidates'

const user = (text: string, toolResults?: unknown[]): Message => ({ role: 'user', text, toolUses: [], ...(toolResults ? { toolResults } : {}) })
const claude = (text: string, tools: string[] = []): Message => ({ role: 'assistant', text, toolUses: tools.map(tool => ({ tool })) })

describe('会話の切り詰め', () => {
  test('ツールの入出力は落とし、ツール名だけ回数つきで残す', () => {
    const secret = 'TOOL-OUTPUT-SHOULD-NOT-APPEAR'
    const messages: Message[] = [
      user('example-app の README を直して'),
      { role: 'assistant', text: '読みます。', toolUses: [{ tool: 'Read', input: { file_path: secret } } as never] },
      user('', [{ tool_use_id: 'x', text: secret }]),
      claude('', ['Read']),
      user('', [{ tool_use_id: 'y', text: secret }]),
      claude('直しました。テストも足しますか？', ['Edit']),
    ]
    const text = transcriptOf(messages)

    expect(text).not.toContain(secret)
    expect(text).toContain('[ユーザー]\nexample-app の README を直して')
    expect(text).toContain('（使ったツール: Read×2, Edit）')
    expect(text).toContain('テストも足しますか？')
    // Claude の連続した行は 1 つにまとまる。
    expect(text.match(/\[Claude\]/g)?.length).toBe(1)
  })

  test('注記（system-reminder など）は中身ごと落とす', () => {
    expect(cleanText('依頼です<system-reminder>内部の注記</system-reminder>')).toBe('依頼です')
    expect(cleanText('<command-name>/review</command-name>')).toBe('/review')
    expect(cleanText('a<local-command-stdout>長い出力</local-command-stdout>b')).toBe('ab')
  })

  test('直近から遡って上限の文字数までしか入れない', () => {
    const messages: Message[] = []

    for (let i = 0; i < 200; i += 1) {
      messages.push(user(`依頼${i} ${'あ'.repeat(500)}`))
      messages.push(claude(`返答${i} ${'い'.repeat(1500)}`))
    }

    const text = transcriptOf(messages)

    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET)
    expect(text.length).toBeGreaterThan(TRANSCRIPT_BUDGET * 0.8)
    expect(text).toContain('返答199')
    expect(text).not.toContain('依頼0 ')
    // 新しいものが後ろ（時系列順）。
    expect(text.indexOf('依頼198')).toBeLessThan(text.indexOf('依頼199'))
  })

  test('長い 1 発言は頭と終わりを残して縮める', () => {
    const text = transcriptOf([user(`頭${'x'.repeat(10_000)}尾`)])

    expect(text.length).toBeLessThan(2_000)
    expect(text).toContain('頭')
    expect(text).toContain('尾')
    expect(text).toContain('文字略')
  })

  test('直前の依頼はいちばん新しいユーザーの発言（ツール結果の行は飛ばす）', () => {
    expect(lastUserText([user('一つ目'), claude('はい'), user('二つ目'), claude('', ['Bash']), user('', [{}])])).toBe('二つ目')
    expect(lastUserText([])).toBe('')
  })

  test('依頼文に会話と直前の依頼が入る', () => {
    const prompt = promptOf('[ユーザー]\nこんにちは', 'こんにちは', 4)

    expect(prompt).toContain('<conversation>')
    expect(prompt).toContain('直前のユーザーの依頼: 「こんにちは」')
    expect(prompt).toContain('6 個')
  })
})

describe('JSON の取り出し', () => {
  test('素直な配列', () => {
    expect(parseCandidates('["テストも書いて","コミットして","差分を見せて","PR を作って"]', 4)).toEqual([
      'テストも書いて',
      'コミットして',
      '差分を見せて',
      'PR を作って',
    ])
  })

  test('前置きやコードフェンスがあっても読む', () => {
    expect(parseCandidates('候補です:\n```json\n["a を直して", "b を見て"]\n```\n以上', 4)).toEqual(['a を直して', 'b を見て'])
  })

  test('壊れた出力は捨てる', () => {
    expect(parseCandidates('["途中で切れた', 4)).toEqual([])
    expect(parseCandidates('候補はありません', 4)).toEqual([])
    expect(parseCandidates('{"a": 1}', 4)).toEqual([])
    expect(parseCandidates('', 4)).toEqual([])
  })

  test('文字列以外・空・重複・直前の依頼は除き、件数の上限で切る', () => {
    const reply = JSON.stringify(['コミットして', 1, '', '  コミットして。 ', 'テストも書いて', '直前の依頼', 'A', 'B', 'C', 'D'])

    expect(parseCandidates(reply, 4, ['直前の依頼'])).toEqual(['コミットして', 'テストも書いて', 'A', 'B'])
  })

  test('改行は均し、囲みのかぎ括弧は外す', () => {
    expect(parseCandidates('["「README も\\n直して」"]', 4)).toEqual(['README も 直して'])
  })

  test('標準の提案を先頭に足し、重なりは除く', () => {
    expect(mergeCandidates('コミットして', ['テストも書いて', 'コミットして', '差分を見せて', 'PR を作って'], 4, '')).toEqual([
      'コミットして',
      'テストも書いて',
      '差分を見せて',
      'PR を作って',
    ])
    expect(mergeCandidates('直前の依頼', ['x'], 4, '直前の依頼')).toEqual(['x'])
  })
})

describe('似た候補を除く', () => {
  test('同じ選択肢を選ぶ言い換えは 1 つにまとめる（標準の提案を優先）', () => {
    expect(
      mergeCandidates('1で実装して', ['1 番でいいよ、実装して', '2 番で作って、コストは後でいい', 'とりあえず 1 番で進めて', 'テストも書いて'], 4, ''),
    ).toEqual(['1で実装して', '2 番で作って、コストは後でいい', 'テストも書いて'])
  })

  test('言い回しだけ違うものは除き、違う依頼は残す', () => {
    expect(isSimilar('コミットしてpushして', 'pushして')).toBe(true)
    expect(isSimilar('README を直して', 'README も直して')).toBe(true)
    expect(isSimilar('テストも書いて', 'コミットして')).toBe(false)
    expect(isSimilar('差分を見せて', 'pushして')).toBe(false)
  })

  test('直前の依頼の言い換えも出さない', () => {
    expect(uniqueCandidates(['pushして', '差分を見せて'], 4, ['コミットしてpushして'])).toEqual(['差分を見せて'])
  })

  test('種類つきの返事は、同じ種類を 1 つだけ残す', () => {
    const reply = JSON.stringify([
      { kind: '答える', text: '1 で進めて' },
      { kind: '答える', text: 'やっぱり 2 で' },
      { kind: '確かめる', text: '動くか試して' },
      { kind: '片付ける', text: 'コミットして' },
      { kind: '進める', text: '次の画面も作って' },
    ])

    expect(parseCandidates(reply, 4)).toEqual(['1 で進めて', '動くか試して', 'コミットして', '次の画面も作って'])
  })

  test('モデルには多めに、種類を分けて頼む', () => {
    expect(requestCountOf(4)).toBe(6)
    expect(requestCountOf(6)).toBe(KINDS.length)
    expect(systemOf(4)).toContain('1 つの種類は 1 回だけ')
  })
})

describe('会話の指紋', () => {
  const talk = (answer: string): Message[] => [
    { role: 'user', text: '直して' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Edit' }] },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', text: answer },
  ]

  test('同じ位置なら同じ、返事が違えば違う。空の会話は null', () => {
    expect(fingerprintOf(talk('直しました'))).toBe(fingerprintOf(talk('直しました')))
    expect(fingerprintOf(talk('直しました'))).not.toBe(fingerprintOf(talk('別の返事')))
    expect(fingerprintOf([...talk('直しました'), { role: 'user', text: '次も' }])).not.toBe(fingerprintOf(talk('直しました')))
    expect(fingerprintOf([])).toBeNull()
  })
})

describe('ラベル', () => {
  test('幅は全角を 2 セルで数える', () => {
    expect(cellWidth('abc')).toBe(3)
    expect(cellWidth('テスト')).toBe(6)
  })

  test('長ければ末尾を … で切り、幅に収める', () => {
    const label = truncateLabel('とても長い依頼文をそのまま出すと帯からはみ出してしまう', 20)

    expect(label.endsWith('…')).toBe(true)
    expect(cellWidth(label)).toBeLessThanOrEqual(20)
    expect(truncateLabel('短い', 20)).toBe('短い')
  })

  test('2 行に収まらない候補は並べない', () => {
    const many = Array.from({ length: 6 }, (_, i) => `${i}番目の候補${'あ'.repeat(20)}`)
    const placed = layoutLabels(many, 60)

    expect(placed.length).toBeGreaterThan(0)
    expect(placed.length).toBeLessThan(6)
    expect(placed.map(p => p.index)).toEqual(placed.map((_, i) => i))

    for (const p of placed) expect(cellWidth(p.label)).toBeLessThanOrEqual(48)
  })
})
