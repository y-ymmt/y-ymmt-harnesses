// prompt-trail が本家に足した 4 つの機能のテスト（帯の並び・入力欄へ/コピー・検索の揺れ・色分け）と、日本語化。
import { describe, expect, mock, test, type FoundElement } from 'claude-code/testing'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from '../hooks/band.ts'
import { pickPrompt, turnLine } from '../hooks/index.tsx'
import { KIND_COLORS, KIND_ORDER, MARK, STRIP, fold, helpText, holds, kindOf } from '../hooks/trail.ts'

const PLUGIN = 'prompt-trail'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 104, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const pane = (placement: 'dock' | 'inline', bodyColumns: number) => ({
  title: 'プロンプト',
  isFocused: false,
  bodyColumns,
  placement,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})
const prompt = (text: string, onScreen: { first: number; last: number; of: number } | null = null) => ({
  text,
  origin: { kind: 'composer' as const },
  isExpanded: false,
  onScreen,
})

// トランスクリプトの JSONL。各行の親は 1 つ前の行。
const jsonl = (rows: Record<string, unknown>[]) =>
  rows.map((row, i) => JSON.stringify({ parentUuid: i === 0 ? null : rows[i - 1]?.uuid, ...row })).join('\n')

type World = {
  transcript: string
  mtimeMs: number
  toasts: string[]
  copied: string[]
  fills: { text: string; mode: string }[]
  draft: string
    submits: string[]
  commands: { name: string; description: string }[]
  copyAnswer: unknown
}

// 下（engine）の代わり。トランスクリプトは /t/s1.jsonl。
const world = (on: any, transcript = jsonl([]), { band = true } = {}) => {
  const w: World = { transcript, mtimeMs: 1, toasts: [], copied: [], fills: [], draft: '', submits: [], commands: [], copyAnswer: { isCopied: true } }
  mock.store(on)
  on('fs.read', () => ({ value: w.transcript }))
  on('fs.stat', () => ({ value: { kind: 'file', size: new TextEncoder().encode(w.transcript).length, mtimeMs: w.mtimeMs, isLink: false } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('command.register', ($: any, e: any) => {
    w.commands.push(e)
    return { value: { command: e.name } }
  })
  on('config.set', ($: any, e: any) => ({ value: e.value }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($: any, e: any) => {
    w.copied.push(e.text)
    return { value: w.copyAnswer }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', ($: any, e: any) => {
    w.fills.push({ text: e.text, mode: e.mode })
    w.draft = e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($: any, e: any) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }))
  if (band) on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Box({}))
  return w
}

const runCommand = ($: any, args: string, command = PLUGIN) => $.command.run({ command, args })
const resume = ($: any) => $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
const drawRow = async ($: any, requestId: string, text: string, onScreen: { first: number; last: number; of: number } | null = null) => {
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, onScreen) })
  await row.unmount()
}
const keysOf = (found: FoundElement[]) => found.map(node => String(node.key))

// ---------------------------------------------------------------------------
// 1. 帯の並び順
// ---------------------------------------------------------------------------

describe('帯の並び（band.ts）', () => {
  // 帯を使う他の 3 プラグインの組み方（先に next を呼び、band.ts の枠に入れて積み直す）を写したもの。
  // 描いた木（plain data）どうしを組むので、ここでは要素を素の値で作る。
  type Node = { type: string; props: Record<string, unknown>; children: unknown[] }
  const box = (key: string | undefined, children: unknown[]): Node => ({ type: 'Box', props: key === undefined ? {} : { key }, children })
  const button = (key: string): Node => ({ type: 'Button', props: { key, label: key }, children: [] })
  const stack = (beneath: unknown, mine: Node[]): Node => ({ type: 'Box', props: { key: BAND_STACK, flexDirection: 'column' }, children: stackBand(beneath, mine) })
  type Wrap = (beneath: unknown) => Node
  const tokyoBoard: Wrap = beneath =>
    stack(beneath, [
      box(slotKey(BAND_ORDER.board, 'tokyo-board'), [{ type: 'Text', props: {}, children: ['天気・運行'] }]),
      box(slotKey(BAND_ORDER.boardToggle, 'board-toggle'), [button('board-toggle')]),
    ])
  const touchTree: Wrap = beneath => stack(beneath, [box(slotKey(BAND_ORDER.touchTreeToggle, 'touch-tree'), [button('touch-tree-toggle')])])
  const nextPrompts: Wrap = beneath => stack(beneath, [box(slotKey(BAND_ORDER.nextPrompts, 'next-prompts'), [button('next-prompts-0')])])
  const OTHERS: [string, Wrap][] = [
    ['tokyo-board', tokyoBoard],
    ['touch-tree', touchTree],
    ['next-prompts', nextPrompts],
  ]

  const permutations = <T,>(items: T[]): T[][] =>
    items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]))
  const flat = (node: unknown): Node[] =>
    typeof node !== 'object' || node === null ? [] : [node as Node, ...((node as Node).children ?? []).flatMap(flat)]
  // 上から順に、帯の各行が何か。
  const rowsOf = (drawn: unknown): string[] =>
    ((drawn as Node).children ?? []).flatMap(child => {
      const nodes = flat(child)
      if (nodes.some(n => n.type === 'Text' && (n.children ?? []).includes('天気・運行'))) return ['board']
      const keys = nodes.filter(n => n.type === 'Button').map(n => String(n.props['key']))
      if (keys.some(k => k.startsWith('jump-'))) return ['prompt-trail']
      return keys.length === 0 ? [] : [keys.join(',')]
    })

  test('4 つのプラグインのどの読み込み順でも、ボード → touch-tree → 天気・運行 → prompt-trail → 次の一手 に並ぶ', async ($, on) => {
    world(on, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]), { band: false })
    // 下の描画は、その順で prompt-trail より内側にあるプラグインが組んだもの。テストごとに入れ替える。
    let inner: Wrap[] = []
    on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
      const tree = inner.reduceRight<unknown>((beneath, wrap) => wrap(beneath), { type: 'engine' })
      const { Box, Text, Button } = $.ui.resolve(e)
      // 素の値の木を、描ける要素の木に起こし直す（engine の描画は空の Box）。
      const build = (node: any): any =>
        node.type === 'engine' || node.type === undefined
          ? Box({})
          : node.type === 'Text'
            ? Text({ children: node.children.join('') })
            : node.type === 'Button'
              ? Button({ key: node.props.key, label: node.props.label, onPress: () => {} })
              : Box({ ...node.props, children: node.children.map(build) })
      return build(tree)
    })
    await resume($)
    await runCommand($, 'horizontal')
    const all: [string, Wrap | 'mine'][] = [...OTHERS, ['prompt-trail', 'mine']]
    const orders = permutations(all)
    expect(orders.length).toBe(24)
    for (const order of orders) {
      const at = order.findIndex(([, wrap]) => wrap === 'mine')
      // order は外側から内側。prompt-trail より内側のものは下の描画として渡し、外側のものは描いた結果を包む。
      inner = order.slice(at + 1).map(([, wrap]) => wrap as Wrap)
      const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
      const mine = await band.drawn()
      await band.unmount()
      const outer = order.slice(0, at).map(([, wrap]) => wrap as Wrap)
      const drawn = outer.reduceRight<unknown>((beneath, wrap) => wrap(beneath), mine)
      const name = order.map(([n]) => n).join(' > ')
      expect(rowsOf(drawn), name).toEqual(['board', 'touch-tree-toggle', 'board-toggle', 'prompt-trail', 'next-prompts-0'])
    }
  })

  test('band.ts の並び順: prompt-trail は天気・運行ボタンと次の一手の間', () => {
    expect(BAND_ORDER.boardToggle).toBeLessThan(BAND_ORDER.promptTrail)
    expect(BAND_ORDER.promptTrail).toBeLessThan(BAND_ORDER.nextPrompts)
  })

  test('他に誰も居なければ、prompt-trail の行だけを返す（engine の空の帯は置き換える）', async ($, on) => {
    world(on, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]))
    await resume($)
    await runCommand($, 'horizontal')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const drawn = (await band.drawn()) as any
    expect(drawn.props.key).toBe(BAND_STACK)
    // engine の代わりの空の Box（約束を知らない描画）は上に残り、その下に prompt-trail の枠。
    const slots = drawn.children.filter((child: any) => String(child?.props?.key).startsWith('y-ymmt-band:'))
    expect(slots.map((child: any) => child.props.key)).toEqual([slotKey(BAND_ORDER.promptTrail, PLUGIN)])
  })

  test('off・アンケート中・サブエージェントの表示中は、下の描画をそのまま返す', async ($, on) => {
    world(on, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]))
    await resume($)
    await runCommand($, 'horizontal')
    for (const props of [{ ...BAND, hasSurvey: true }, { ...BAND, view: { agentId: 'ag1' } }]) {
      const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props })
      expect(((await band.drawn()) as any).props?.key).not.toBe(BAND_STACK)
      await band.unmount()
    }
    await runCommand($, 'off')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'jump-0' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. 日本語化
// ---------------------------------------------------------------------------

describe('日本語化', () => {
  test('コマンドは /prompt-trail（本家と別の名前）で、説明は日本語', async ($, on) => {
    const w = world(on)
    const commands = w.commands
    await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true } as any)
    expect(commands.map(c => c.name)).toEqual(['prompt-trail', 'prompt-trail-next', 'prompt-trail-prev'])
    expect(commands.map(c => c.name).some(name => name.startsWith('prompt-rail'))).toBe(false)
    for (const command of commands) expect(command.description).toMatch(/[ぁ-んァ-ン一-龠]/)
  })

  test('/prompt-trail help は使い方と色の凡例を返す', async ($, on) => {
    world(on)
    const answer = await runCommand($, 'help')
    expect(answer.text).toBe(helpText())
    for (const word of ['入力欄へ', 'コピー', '拒否', '中断', '失敗', '編集', '読むだけ', '実行中', 'find']) expect(answer.text).toContain(word)
  })

  test('知らない引数には日本語の使い方、見つからないときは日本語のトースト', async ($, on) => {
    const w = world(on, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]))
    await resume($)
    await runCommand($, 'sideways')
    await runCommand($, '9')
    await runCommand($, 'find 存在しない語')
    expect(w.toasts).toEqual([expect.stringMatching(/^使い方: \/prompt-trail /), 'プロンプト 9 はありません', '「存在しない語」を含むプロンプトはありません'])
  })

  test('空のペインと、ターンの要約は日本語', async ($, on) => {
    world(on)
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane('inline', 60) })
    expect(await site.find({ type: 'Text', text: 'まだプロンプトがありません' })).toBeDefined()
    expect(turnLine({ durationMs: 83_000, tools: 4, files: ['/w/a.ts'], failed: 1, rejected: 2 })).toBe('1分23秒 · ツール 4 · 拒否 2 · 失敗 1 · 編集 1（a.ts）')
  })
})

// ---------------------------------------------------------------------------
// 3. 過去のプロンプトを再利用（入力欄へ・コピー）
// ---------------------------------------------------------------------------

const TWO = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second prompt\nwith a second line' } },
])

describe('入力欄へ・コピー', () => {
  const band = async ($: any) => {
    await resume($)
    await runCommand($, 'horizontal')
    return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  }

  test('ホバーのカードごとに [ 入力欄へ ] [ コピー ] があり、押すと入力欄に入れる（置き換え、送信はしない）', async ($, on) => {
    const w = world(on, TWO)
    const site = await band($)
    expect(keysOf(await site.findAll({ type: 'Button' })).filter(k => /^(fill|copy)-/.test(k))).toEqual(['fill-0', 'copy-0', 'fill-1', 'copy-1'])
    expect((await site.find({ key: 'fill-0' }))?.props.label).toBe('入力欄へ')
    expect((await site.find({ key: 'copy-0' }))?.props.label).toBe('コピー')
    await site.press({ key: 'fill-1' })
    // 改行もそのまま入れる。
    expect(w.fills).toEqual([{ text: 'second prompt\nwith a second line', mode: 'replace' }])
    expect(w.submits).toEqual([])
    // 飛ぼうとしない（テストの engine では飛ぼうとすると「no implementation for ui.scroll」のトーストが出る）。
    expect(w.toasts).toEqual([])
  })

  test('打ちかけの文があるときは、もう一度押すまで置き換えない', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, TWO)
    w.draft = 'いま打っている文'
    const site = await band($)
    await site.press({ key: 'fill-0' })
    expect(w.fills).toEqual([])
    expect(w.toasts).toEqual(['入力欄に打ちかけの文があります。もう一度押すと置き換えます'])
    // 別のボタンでは確かめ直し。
    await site.press({ key: 'fill-1' })
    expect(w.fills).toEqual([])
    await site.press({ key: 'fill-1' })
    expect(w.fills).toEqual([{ text: 'second prompt\nwith a second line', mode: 'replace' }])
    // 入れた文（このセッションのプロンプト）のままなら、確かめずに置き換える。
    await site.press({ key: 'fill-0' })
    expect(w.fills.at(-1)).toEqual({ text: 'first prompt', mode: 'replace' })
    // 待ちすぎたら確かめ直し。
    w.draft = '別の打ちかけ'
    await site.press({ key: 'fill-1' })
    await clock.advance(6000)
    await site.press({ key: 'fill-1' })
    expect(w.fills.length).toBe(2)
  })

  test('[ コピー ] はプロンプトの全文をコピーしてトーストで知らせる', async ($, on) => {
    const w = world(on, TWO)
    const site = await band($)
    await site.press({ key: 'copy-1' })
    expect(w.copied).toEqual(['second prompt\nwith a second line'])
    expect(w.toasts).toEqual(['#2 をコピーしました'])
    expect(w.fills).toEqual([])
  })

  test('コピーできなかったらそう言う', async ($, on) => {
    const w = world(on, TWO)
    w.copyAnswer = { isCopied: false, reason: 'no-surface' }
    const site = await band($)
    await site.press({ key: 'copy-0' })
    expect(w.toasts).toEqual(['コピーできませんでした（クリップボードのある画面がありません）'])
  })

  test('棒を押すと、そのカード（ボタンつき）がしばらく文字の行に残る', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, TWO)
    const site = await band($)
    expect(await site.find({ key: 'fill-0-pin' })).toBeUndefined()
    // テストの engine は会話をスクロールしない（飛べたかどうかに関わらず、カードは残す）。
    await site.press({ key: 'jump-0' })
    expect(await site.find({ key: 'fill-0-pin' })).toBeDefined()
    await site.press({ key: 'fill-0-pin' })
    expect(w.fills).toEqual([{ text: 'first prompt', mode: 'replace' }])
    await clock.advance(8000)
    expect(await site.find({ key: 'fill-0-pin' })).toBeUndefined()
  })

  test('狭い帯ではカードにボタンを置かない（コマンドで使う）', async ($, on) => {
    world(on, TWO)
    await resume($)
    await runCommand($, 'horizontal')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 50 } })
    expect(await site.find({ key: 'fill-0' })).toBeUndefined()
    expect(await site.find({ key: 'jump-0' })).toBeDefined()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`縦のペインでは、読んでいる行か押した行の下に [ 入力欄へ ] [ コピー ] の行を出す（${surface}）`, async ($, on) => {
      const clock = mock.clock(on)
      const w = world(on, TWO)
      await resume($)
      await runCommand($, 'vertical')
      await drawRow($, 'u2', 'second prompt\nwith a second line', { first: 0, last: 1, of: 2 })
      await clock.advance(200)
      const placement = surface === 'terminal' ? 'dock' : 'inline'
      const site = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane(placement, 40) })
      // 読んでいるのは 2 番目。
      expect(keysOf(await site.findAll({ type: 'Button' })).filter(k => /^(fill|copy)-/.test(k))).toEqual(['fill-1', 'copy-1'])
      await site.press({ key: 'jump-0' })
      expect(keysOf(await site.findAll({ type: 'Button' })).filter(k => /^(fill|copy)-/.test(k))).toEqual(['fill-0', 'copy-0'])
      await site.press({ key: 'copy-0' })
      expect(w.copied).toEqual(['first prompt'])
      await site.press({ key: 'fill-0' })
      expect(w.fills).toEqual([{ text: 'first prompt', mode: 'replace' }])
    })
  }

  test('狭いペインでは [ 入力欄へ ] [ コピー ] の行を出さない', async ($, on) => {
    world(on, TWO)
    await resume($)
    await runCommand($, 'vertical')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane('dock', 20) })
    expect(keysOf(await site.findAll({ type: 'Button' })).filter(k => /^(fill|copy)-/.test(k))).toEqual([])
  })

  test('/prompt-trail fill・copy は番号のプロンプトを、番号が無ければ読んでいる（分からなければ最新の）ものを使う', async ($, on) => {
    const w = world(on, TWO)
    await resume($)
    await runCommand($, 'fill 1')
    await runCommand($, 'copy')
    await runCommand($, 'ｃｏｐｙ　＃１')
    await runCommand($, 'fill 3')
    expect(w.fills).toEqual([{ text: 'first prompt', mode: 'replace' }])
    expect(w.copied).toEqual(['second prompt\nwith a second line', 'first prompt'])
    expect(w.toasts.at(-1)).toBe('プロンプト 3 はありません')
  })
})

// ---------------------------------------------------------------------------
// 4. 検索の揺れ
// ---------------------------------------------------------------------------

describe('find の揺れ', () => {
  test('全角/半角・大文字/小文字・ひらがな/カタカナを区別しない', () => {
    expect(fold('ＡＢＣ　ｄｅｆ')).toBe('abc def')
    expect(fold('ｶﾀｶﾅ')).toBe('かたかな')
    expect(fold('テスト')).toBe('てすと')
    expect(fold('README')).toBe('readme')
    expect(holds('ログイン画面のテストを書いて', 'てすと')).toBe(true)
    expect(holds('Fix the Ｂｕｉｌｄ', 'build')).toBe(true)
    expect(holds('ﾃﾞｰﾀベース', 'データ')).toBe(true)
    expect(holds('anything', '   ')).toBe(false)
  })

  test('find は揺れを区別せず、語を含む最新のプロンプトを選ぶ', () => {
    const texts = ['READMEを直して', 'テストを追加', 'ﾃｽﾄをもう一度', 'Ｂｕｉｌｄが落ちる']
    expect(pickPrompt('find readme', texts)).toBe(0)
    expect(pickPrompt('find てすと', texts)).toBe(2)
    expect(pickPrompt('find テスト を追加', texts)).toBe(-1)
    expect(pickPrompt('find テストを追加', texts)).toBe(1)
    expect(pickPrompt('find build', texts)).toBe(3)
    expect(pickPrompt('ｆｉｎｄ　ＲＥＡＤＭＥ', texts)).toBe(0)
    expect(pickPrompt('find 無い', texts)).toBe(-1)
  })

  // テストの engine は Mod の $.ui.scroll に答えないので、飛ぶ先は pickPrompt（上）で見て、ここでは見つかったことだけを見る。
  test('/prompt-trail find は半角カナでも見つけて飛ぼうとする（見つからないときだけ「ありません」）', async ($, on) => {
    const w = world(on, jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'ログイン画面のテスト' } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'deploy して（デプロイ）' } },
    ]))
    await resume($)
    await runCommand($, 'find ﾃｽﾄ')
    await runCommand($, 'find ＤＥＰＬＯＹ')
    expect(w.toasts.filter(text => text.includes('ありません'))).toEqual([])
    await runCommand($, 'find でぷろい')
    expect(w.toasts.filter(text => text.includes('ありません'))).toEqual([])
    await runCommand($, 'find ビルド')
    expect(w.toasts.filter(text => text.includes('ありません'))).toEqual(['「ビルド」を含むプロンプトはありません'])
  })
})

// ---------------------------------------------------------------------------
// 5. ターンの結果の色分け
// ---------------------------------------------------------------------------

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) })
const REJECTED_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
const CLASSIFIER_TEXT = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked.'

// 1 プロンプトにつき 1 ターン。ターンで起きたことはトランスクリプトの行どおり。
const OUTCOMES = jsonl([
  // 読むだけ
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'read it' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [toolUse('t1', 'Read', { file_path: '/w/a.ts' })] } },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [result('t1', 'ok')] } },
  // 編集した
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'edit it' } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [toolUse('t2', 'Edit', { file_path: '/w/a.ts' }), toolUse('t2b', 'NotebookEdit', { notebook_path: '/w/n.ipynb' })] } },
  { type: 'user', uuid: 'r2', message: { role: 'user', content: [result('t2', 'ok'), result('t2b', 'ok')] } },
  // 編集もしたが、ツールが失敗した
  { type: 'user', uuid: 'u3', message: { role: 'user', content: 'edit and test' } },
  { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [toolUse('t3', 'Write', { file_path: '/w/b.ts' }), toolUse('t4', 'Bash', { command: 'npm test' })] } },
  { type: 'user', uuid: 'r3', message: { role: 'user', content: [result('t3', 'ok'), result('t4', 'Exit code 1', true)] } },
  // 本人が No を選んだ（拒否 + 中断の行）
  { type: 'user', uuid: 'u4', message: { role: 'user', content: 'delete it' } },
  { type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [toolUse('t5', 'Bash', { command: 'rm x' })] } },
  { type: 'user', uuid: 'r4', toolUseResult: 'User rejected tool use', message: { role: 'user', content: [result('t5', REJECTED_TEXT, true)] } },
  { type: 'user', uuid: 'i4', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  // Esc で止めた
  { type: 'user', uuid: 'u5', message: { role: 'user', content: 'think long' } },
  { type: 'assistant', uuid: 'a5', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
  { type: 'user', uuid: 'i5', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  // 失敗した編集だけ（編集したことにならない）
  { type: 'user', uuid: 'u6', message: { role: 'user', content: 'fix typo' } },
  { type: 'assistant', uuid: 'a6', message: { role: 'assistant', content: [toolUse('t6', 'Edit', { file_path: '/w/c.ts' })] } },
  { type: 'user', uuid: 'r6', message: { role: 'user', content: [result('t6', '<tool_use_error>String to replace not found in file.</tool_use_error>', true)] } },
  // auto mode の判定で止められた
  { type: 'user', uuid: 'u7', message: { role: 'user', content: 'push it' } },
  { type: 'assistant', uuid: 'a7', message: { role: 'assistant', content: [toolUse('t7', 'Bash', { command: 'git push' })] } },
  { type: 'user', uuid: 'r7', message: { role: 'user', content: [result('t7', CLASSIFIER_TEXT, true)] } },
  // API エラー
  { type: 'user', uuid: 'u8', message: { role: 'user', content: 'again' } },
  { type: 'assistant', uuid: 'a8', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } },
  // 答えただけ
  { type: 'user', uuid: 'u9', message: { role: 'user', content: 'thanks' } },
  { type: 'assistant', uuid: 'a9', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
])
const EXPECTED_KINDS = ['quiet', 'edited', 'failed', 'rejected', 'interrupted', 'failed', 'rejected', 'failed', 'quiet'] as const

describe('ターンの結果の色分け', () => {
  test('優先順: 実行中 > 拒否 > 中断 > 失敗 > 編集 > 読むだけ', () => {
    expect(KIND_ORDER).toEqual(['running', 'rejected', 'interrupted', 'failed', 'edited', 'quiet'])
    const all = { outcome: 'interrupted' as const, files: ['a'], failed: 1, rejected: 1 }
    expect(kindOf({ ...all, outcome: 'running' })).toBe('running')
    expect(kindOf(all)).toBe('rejected')
    expect(kindOf({ ...all, rejected: 0 })).toBe('interrupted')
    expect(kindOf({ files: ['a'], failed: 1 })).toBe('failed')
    expect(kindOf({ files: ['a'], outcome: 'error' })).toBe('failed')
    expect(kindOf({ files: ['a'] })).toBe('edited')
    expect(kindOf({ files: [] })).toBe('quiet')
    // 色はすべて別。
    expect(new Set(Object.values(KIND_COLORS)).size).toBe(KIND_ORDER.length)
  })

  test('帯: 棒の下の色の帯が、トランスクリプトから決めたターンの種類の色になる', async ($, on) => {
    world(on, OUTCOMES)
    await resume($)
    await runCommand($, 'horizontal')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const strip = await site.findAll({ type: 'Text', text: STRIP })
    expect(strip.map(node => node.props.color)).toEqual(EXPECTED_KINDS.map(kind => KIND_COLORS[kind]))
  })

  test('縦のペイン: 行の頭の印が同じ色になる（terminal・desktop）', async ($, on) => {
    world(on, OUTCOMES)
    await resume($)
    await runCommand($, 'vertical')
    for (const [surface, placement] of [['terminal', 'dock'], ['desktop', 'inline']] as const) {
      const site = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane(placement, 40) })
      const marks = await site.findAll({ type: 'Text', text: MARK })
      expect(marks.map(node => node.props.color), surface).toEqual(EXPECTED_KINDS.map(kind => KIND_COLORS[kind]))
      await site.unmount()
    }
  })

  test('カードには時間・ツールの数に加えて、拒否・失敗したツールの数と編集したファイルの数が出る', async ($, on) => {
    world(on, OUTCOMES)
    await resume($)
    await runCommand($, 'horizontal')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const card = async (n: number) => String((await site.find({ type: 'Text', text: new RegExp(`^#${n} `) }))?.text).trimEnd()
    expect(await card(1)).toBe('#1 read it · ツール 1')
    expect(await card(2)).toBe('#2 edit it · ツール 2 · 編集 2（a.ts, n.ipynb）')
    expect(await card(3)).toBe('#3 edit and test · ツール 2 · 失敗 1 · 編集 1（b.ts）')
    expect(await card(4)).toBe('#4 delete it · 中断 · ツール 1 · 拒否 1')
    expect(await card(5)).toBe('#5 think long · 中断')
    expect(await card(6)).toBe('#6 fix typo · ツール 1 · 失敗 1')
    expect(await card(7)).toBe('#7 push it · ツール 1 · 拒否 1')
    expect(await card(8)).toBe('#8 again · API エラー')
  })

  test('走っている間は実行中の色、終わったら結果の色', async ($, on) => {
    const w = world(on, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]))
    await resume($)
    await runCommand($, 'horizontal')
    await $.prompt.submit({ text: 'second', wait: false, origin: { kind: 'composer' } } as any)
    await drawRow($, 'placeholder', 'second')
    await $.turn.start({ text: 'second', turnId: 't2' } as any)
    await drawRow($, 'u2', 'second')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const colors = async () => (await site.findAll({ type: 'Text', text: STRIP })).map(node => node.props.color)
    expect(await colors()).toEqual([KIND_COLORS.quiet, KIND_COLORS.running])
    w.transcript = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [toolUse('t1', 'Edit', { file_path: '/w/a.ts' })] } },
      { type: 'user', uuid: 'r2', message: { role: 'user', content: [result('t1', 'ok')] } },
    ])
    w.mtimeMs = 2
    await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false } as any)
    await $.turn.complete({ answer: 'done', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer' } as any)
    expect(await colors()).toEqual([KIND_COLORS.quiet, KIND_COLORS.edited])
  })

  test('colors をオフにすると色の帯も印も描かない', { options: { colors: false } }, async ($, on) => {
    world(on, OUTCOMES)
    await resume($)
    await runCommand($, 'horizontal')
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await site.findAll({ type: 'Text', text: STRIP })).toEqual([])
  })
})
