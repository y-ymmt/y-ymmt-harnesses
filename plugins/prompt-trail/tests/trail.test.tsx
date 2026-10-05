// prompt-trail が本家に足した 4 つの機能のテスト（帯の並び・入力欄へ/コピー・検索の揺れ・色分け）と、日本語化。
import { describe, expect, mock, test, type FoundElement } from 'claude-code/testing'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from '../hooks/band.ts'
import { bindCommandRows, firstReplies, indexRows, jumpTargets, pickPrompt, turnLine } from '../hooks/index.tsx'
import { KIND_COLORS, KIND_ORDER, MARK, STRIP, fold, helpText, commandRowText, holds, isCommandText, isSlashCommand, kindOf, slashName } from '../hooks/trail.ts'

const PLUGIN = 'prompt-trail'
type Entry = { id: string; text: string; command?: true }
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

// ---------------------------------------------------------------------------
// 6. ホバーのカードの位置（ボタンが頭・棒の真上）と、棒からカードへ指を上げてもカードが消えない組み方
// ---------------------------------------------------------------------------

// 描いた木の子（文字列と要素）を、要素だけ順に。描いた木では Box・Button の key は残り、Text の key は残らない。
// ホバーは要素の `hover`（props の外）に入る。
type Drawn = { type: string; props?: Record<string, any>; hover?: Record<string, unknown>; children?: unknown[] }
const elementsOf = (node: FoundElement | Drawn | undefined): Drawn[] =>
  (node?.children ?? []).filter((child): child is Drawn => typeof child === 'object' && child !== null && 'type' in child)
const textOf = (node: Drawn): string =>
  (node.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child as Drawn))).join('')
// 要素の並びを読める形に: Button は key、Text は「Text」。
const shapeOf = (node: Drawn) => (node.type === 'Button' ? String(node.props?.['key']) : node.type)
const prompts = (n: number) => jsonl(Array.from({ length: n }, (_, i) => ({ type: 'user', uuid: `p${i + 1}`, message: { role: 'user', content: `prompt ${i + 1}` } })))
// 帯の幅 104 から、左右の空き 2 と左の余白 2 を引いた、帯の行の幅。
const ROW = 100
// 端末の帯で、棒 i の Box と、その中のカード（key の無い絶対配置の Box）。
const barBox = async (site: any, i: number): Promise<FoundElement | undefined> => site.find({ key: `bar-${i}` })
const cardIn = async (site: any, i: number) => elementsOf(await barBox(site, i)).find(node => node.type === 'Box')
// カードの頭の空き（ボタンを棒の上へずらす幅）。空きが無ければ 0。
const leadIn = (card: Drawn | undefined) => {
  const [head] = elementsOf(card)
  return head?.type === 'Text' ? textOf(head).length : 0
}

describe('カードの位置とホバー', () => {
  const band = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = BAND.bodyColumns) => {
    await resume($)
    await runCommand($, 'horizontal')
    return $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns } })
  }

  test('カードの行は [ 入力欄へ ] [ コピー ] が頭で、本文（#番号・ターンの要約）はその後ろ', async ($, on) => {
    world(on, TWO)
    const site = await band($)
    const card = await cardIn(site, 1)
    expect(elementsOf(card).map(shapeOf)).toEqual(['fill-1', 'Text', 'copy-1', 'Text', 'Text'])
    const text = elementsOf(card).at(-1)!
    expect(textOf(text).trimEnd()).toBe('#2 second prompt with a second line')
    // 本文は空白で埋めて行の残りを覆う（下の灰色の行が透けない）: ボタン 24 マス + 本文 = 行の幅。
    expect(textOf(text).length).toBe(ROW - 24)
  })

  test('カードは棒ごとの key 付きの Box（棒と色の 1 マス）の中に絶対配置で置かれ、その Box のホバーで出る（棒から指を上げても消えない）', async ($, on) => {
    world(on, TWO)
    const site = await band($)
    for (const i of [0, 1]) {
      const holder = await barBox(site, i)
      expect(holder?.type).toBe('Box')
      const [jump, strip, card] = elementsOf(holder)
      expect(jump && shapeOf(jump)).toBe(`jump-${i}`)
      expect(strip?.type === 'Text' && textOf(strip)).toBe(STRIP)
      // 文字の行（1 行上）の左端から、行の幅いっぱい。ふだんは隠れていて、いちばん近い key 付きの Box（棒の Box）に
      // 指があるうち出る。カードの上の指も親（棒の Box）の上と数えられる。カード自身に key は無い（あると
      // カードがホバーの範囲になり、棒の上では出なくなる）。
      expect(card?.type).toBe('Box')
      expect(card?.props).toMatchObject({ position: 'absolute', top: -1, left: -i, width: ROW, display: 'none' })
      expect(card?.props?.['key']).toBeUndefined()
      expect(card?.hover).toEqual({ display: 'flex' })
      // 棒と色の 1 マスは同じ組（ほかの表示面の要素とも灯り合う）。
      expect(jump?.hover).toMatchObject({ scope: `prompt-trail-${i}`, inverse: true })
      expect(strip?.hover).toMatchObject({ scope: `prompt-trail-${i}`, inverse: true })
    }
    // 文字の行そのものには、ホバーのカードを置かない（棒の Box の外に置くと、カードに指を移した途端に消える）。
    const line = elementsOf(await site.find({ key: slotKey(BAND_ORDER.promptTrail, PLUGIN) }))[0]
    expect(elementsOf(line).some(node => node.hover !== undefined)).toBe(false)
  })

  test('帯の左半分の棒は右へ伸ばす: ボタンが頭で、[ 入力欄へ ] の真ん中が棒の桁。本文に 30 マス残すところまで左へ寄せる', async ($, on) => {
    world(on, prompts(60))
    const site = await band($)
    // 左端の棒はボタンを左へずらせない。
    expect(leadIn(await cardIn(site, 0))).toBe(0)
    expect(leadIn(await cardIn(site, 3))).toBe(0)
    // 棒の桁から 5 マス左: `[ 入力欄へ ]` の 6 マス目（ラベルの真ん中）が棒の真上。
    expect(leadIn(await cardIn(site, 12))).toBe(7)
    expect(leadIn(await cardIn(site, 40))).toBe(35)
    expect(elementsOf(await cardIn(site, 40)).map(shapeOf)).toEqual(['Text', 'fill-40', 'Text', 'copy-40', 'Text', 'Text'])
  })

  test('帯の右半分の棒は左へ伸ばす: 本文・補足・#番号・ボタンの順で、[ コピー ] の右端が棒の真上', async ($, on) => {
    world(on, prompts(60))
    const site = await band($)
    const last = await cardIn(site, 59)
    expect(last?.props).toMatchObject({ left: -59, width: ROW })
    const parts = elementsOf(last)
    expect(parts.map(shapeOf)).toEqual(['Text', 'Text', 'fill-59', 'Text', 'copy-59', 'Text'])
    const [lead, body, , , , rest] = parts as [Drawn, Drawn, Drawn, Drawn, Drawn, Drawn]
    // 棒の桁は 59。ボタン 23 マスの右端がその桁（= 次の桁 60 の手前）で、右の空きが行の残りを覆う。
    const bodyCells = textOf(body).length
    expect(textOf(lead).length + bodyCells + 23).toBe(60)
    expect(textOf(rest).length).toBe(ROW - 60)
    expect(textOf(body).trimEnd().endsWith('#60')).toBe(true)
  })

  test('切り替えは「桁 × 2 が行の幅以上」かつ「右端 + 1 に ボタン 23 + 本文 30 が入る」: 51 は右へ、52 は左へ', async ($, on) => {
    world(on, prompts(60))
    const site = await band($)
    expect(elementsOf(await cardIn(site, 51)).map(shapeOf)).toEqual(['Text', 'fill-51', 'Text', 'copy-51', 'Text', 'Text'])
    expect(elementsOf(await cardIn(site, 52)).map(shapeOf)).toEqual(['Text', 'Text', 'fill-52', 'Text', 'copy-52', 'Text'])
  })

  test('棒が帯いっぱいに並ぶと、右端の棒のカードは本文が広い（ボタンの左に帯の桁 - 23 マス）', async ($, on) => {
    world(on, prompts(150))
    const site = await band($)
    // 150 本は窓（‹ と › を除く 98 本、center は最新）。最後の棒の桁は 98。
    const card = await cardIn(site, 149)
    const parts = elementsOf(card)
    const body = parts.find(node => node.type === 'Text' && textOf(node).includes('#150'))!
    expect(textOf(body).trimEnd()).toBe('prompt 150 #150')
    const copy = parts.findIndex(node => shapeOf(node) === 'copy-149')
    const before = parts.slice(0, copy - 2).reduce((sum, node) => sum + textOf(node).length, 0)
    expect(before + 23).toBe(99)
  })

  test('狭い帯ではボタンを置かず、本文だけのカードを同じ組み方で置く', async ($, on) => {
    world(on, TWO)
    const site = await band($, 'terminal', 50)
    const card = await cardIn(site, 0)
    expect(elementsOf(card).map(shapeOf)).toEqual(['Text'])
    expect(card?.props?.['width']).toBe(46)
    expect(textOf(elementsOf(card)[0]!).length).toBe(46)
  })

  test('色分けがオフでも、カードは棒の Box の中', { options: { colors: false } }, async ($, on) => {
    world(on, TWO)
    const site = await band($)
    expect(elementsOf(await barBox(site, 0)).map(shapeOf)).toEqual(['jump-0', 'Box'])
  })

  test('棒を押したあと残るカードも、ボタンが頭で棒の真上', async ($, on) => {
    mock.clock(on)
    world(on, prompts(20))
    const site = await band($)
    await site.press({ key: 'jump-15' })
    expect(await site.find({ key: 'fill-15-pin' })).toBeDefined()
    const line = elementsOf(await site.find({ key: slotKey(BAND_ORDER.promptTrail, PLUGIN) }))[0]
    const row = elementsOf(line)[0]
    expect(elementsOf(row).map(shapeOf)).toEqual(['Text', 'fill-15-pin', 'Text', 'copy-15-pin', 'Text', 'Text'])
    expect(leadIn(row)).toBe(10)
  })

  test('デスクトップでも、カードの行はボタンが頭', async ($, on) => {
    world(on, TWO)
    const site = await band($, 'desktop')
    const fill = await site.find({ key: 'fill-0' })
    expect(fill).toBeDefined()
    const card = (await site.findAll({ type: 'Box' })).find((node: FoundElement) => elementsOf(node).some(child => shapeOf(child) === 'fill-0'))
    expect(elementsOf(card).map(shapeOf)).toEqual(['fill-0', 'Text', 'copy-0', 'Text', 'Text'])
  })
})

// ---------------------------------------------------------------------------
// 7. 「中断」の付け先（engine の知らせより記録を信じる）
// ---------------------------------------------------------------------------

describe('中断の付け先', () => {
  const cardOf = async ($: any, n: number) => {
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const card = await cardIn(site, n - 1)
    const text = textOf(elementsOf(card).at(-1)!).trimEnd()
    const strip = (await site.findAll({ type: 'Text', text: STRIP })).map((node: FoundElement) => node.props.color)
    await site.unmount()
    return { text, strip }
  }
  const FILED = jsonl([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'pushして' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 5000 },
  ])

  test('行が並ぶ前に取り消されたターンの「中断」は、1 つ前のプロンプトに付けない', async ($, on) => {
    world(on, FILED)
    await resume($)
    await runCommand($, 'horizontal')
    // 送ってすぐ取り消された（その文の行はまだ描かれていない）。
    await $.turn.start({ text: '別の依頼', turnId: 't2' } as any)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    expect(await cardOf($, 1)).toEqual({ text: '#1 pushして · 5秒', strip: [KIND_COLORS.quiet] })
  })

  test('記録に turn_duration の行があるプロンプトは、同じ文で送られて取り消されたターンの「中断」を受けない', async ($, on) => {
    world(on, FILED)
    await resume($)
    await runCommand($, 'horizontal')
    // 同じ文をもう一度送り、行が描かれる前に取り消された。文で探すと前のプロンプトに当たる。
    await $.turn.start({ text: 'pushして', turnId: 't2' } as any)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    expect(await cardOf($, 1)).toEqual({ text: '#1 pushして · 5秒', strip: [KIND_COLORS.quiet] })
  })

  test('送り直されたプロンプト: 取り消された方は記録を読むと消え、送り直した方は記録どおり（中断にならない）', async ($, on) => {
    const w = world(on, FILED)
    await resume($)
    await runCommand($, 'horizontal')
    const text = '「入力欄へ」を左に'
    // 1 回目: 描かれてすぐ取り消される。
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
    await drawRow($, 'placeholder', text)
    await $.turn.start({ text, turnId: 't2' } as any)
    await drawRow($, 'x1', text)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    // 2 回目: 同じ文を同じ親から送り直し、ふつうに答えて終わる。
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
    await drawRow($, 'placeholder', text)
    await $.turn.start({ text, turnId: 't3' } as any)
    await drawRow($, 'y1', text)
    await $.turn.complete({ answer: 'ok', durationMs: 31000, isAborted: false, turnId: 't3', reason: 'answer' } as any)
    // 記録では 1 回目（x1）は本線から外れ、2 回目（y1）に turn_duration が付く。
    w.transcript = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'pushして' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 5000 },
    ]) +
      '\n' +
      [
        { type: 'user', uuid: 'x1', parentUuid: 'd1', message: { role: 'user', content: text } },
        { type: 'user', uuid: 'y1', parentUuid: 'd1', message: { role: 'user', content: text } },
        { type: 'assistant', uuid: 'a2', parentUuid: 'y1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'system', uuid: 'd2', parentUuid: 'a2', subtype: 'turn_duration', durationMs: 30877 },
      ]
        .map(row => JSON.stringify(row))
        .join('\n')
    w.mtimeMs = 2
    await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false } as any)
    expect(await cardOf($, 2)).toEqual({ text: `#2 ${text} · 30秒`, strip: [KIND_COLORS.quiet, KIND_COLORS.quiet] })
  })

  test('記録がまだ無いターンは、これまでどおり engine の知らせで「中断」と出す', async ($, on) => {
    world(on, FILED)
    await resume($)
    await runCommand($, 'horizontal')
    await $.prompt.submit({ text: 'stop me', wait: false, origin: { kind: 'composer' } } as any)
    await drawRow($, 'placeholder', 'stop me')
    await $.turn.start({ text: 'stop me', turnId: 't2' } as any)
    await drawRow($, 'u2', 'stop me')
    await $.turn.complete({ answer: '', durationMs: 4000, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    expect(await cardOf($, 2)).toEqual({ text: '#2 stop me · 4秒 · 中断', strip: [KIND_COLORS.quiet, KIND_COLORS.interrupted] })
  })
})

// ---------------------------------------------------------------------------
// 8. セッションの途中で読み込まれたとき（classic.SessionStart を受け取っていない）の並び
// ---------------------------------------------------------------------------

describe('途中で読み込まれたときの並び', () => {
  const FILE = '/h/.claude/projects/-w-my-proj/s1.jsonl'
  // 置き場所を探す手がかり（HOME・セッションを始めたフォルダ）と、そこにトランスクリプトがあるか。
  type Place = { exists?: (path: string) => boolean; folders?: string[] }
  const place = (on: any, { exists = (path: string): boolean => path === FILE, folders = [] }: Place = {}) => {
    on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
    on('session.root', () => ({ value: '/w/my.proj' }))
    on('session.cwd', () => ({ value: '/w/my.proj' }))
    on('fs.exists', ($: any, e: any) => ({ value: exists(e.path) }))
    on('fs.list', () => ({ value: folders.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  }
  const labels = async ($: any) => {
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane('inline', 60) })
    const found = (await site.findAll({ type: 'Button' })).filter((node: FoundElement) => /^jump-/.test(String(node.key))).map((node: FoundElement) => String(node.props.label).slice(2))
    await site.unmount()
    return found
  }
  const FIVE = prompts(5)

  test('置き場所の決まりからトランスクリプトを見つけ、最初から会話の順に並べる（後から描かれた古い行で順が崩れない）', async ($, on) => {
    world(on, FIVE)
    place(on)
    await $.session.start({ cwd: '/w/my.proj', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    expect(await labels($)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt 4', 'prompt 5'])
    // スクロールで上の（古い）行が後から描かれても、並びは変わらない。
    await drawRow($, 'p5', 'prompt 5')
    await drawRow($, 'p2', 'prompt 2')
    expect(await labels($)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt 4', 'prompt 5'])
  })

  test('フォルダ名が切られた長いパスでも、名前の頭が合うフォルダの中から見つける', async ($, on) => {
    world(on, FIVE)
    place(on, { exists: path => path === '/h/.claude/projects/-w-my-proj-1a2b/s1.jsonl', folders: ['-other', '-w-my-proj-1a2b'] })
    await $.session.start({ cwd: '/w/my.proj', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    expect(await labels($)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt 4', 'prompt 5'])
  })

  test('見つからなければ描かれた行だけを並べ、ターンの終わり（classic.Stop）で記録の順に並べ直す', async ($, on) => {
    world(on, FIVE)
    place(on, { exists: () => false })
    await $.session.start({ cwd: '/w/my.proj', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    // 新しい行から描かれ、上へスクロールすると古い行が後から描かれる。
    await drawRow($, 'p5', 'prompt 5')
    await drawRow($, 'p4', 'prompt 4')
    await drawRow($, 'p1', 'prompt 1')
    expect(await labels($)).toEqual(['prompt 5', 'prompt 4', 'prompt 1'])
    await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false } as any)
    expect(await labels($)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt 4', 'prompt 5'])
  })

  test('classic.* が届かない機械（管理された設定のある機械）: 始めたばかりのセッションでも、ターンの終わりに記録を見つけて読む', async ($, on) => {
    const w = world(on, '')
    let isWritten = false
    place(on, { exists: path => isWritten && path === FILE })
    // classic.SessionStart・classic.Stop は一度も来ない。始めた時点ではトランスクリプトはまだ無い。
    await $.session.start({ cwd: '/w/my.proj', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'horizontal')
    await $.prompt.submit({ text: 'prompt 1', wait: false, origin: { kind: 'composer' } } as any)
    await drawRow($, 'placeholder', 'prompt 1')
    await $.turn.start({ text: 'prompt 1', turnId: 't1' } as any)
    await drawRow($, 'p1', 'prompt 1')
    w.transcript = jsonl([
      { type: 'user', uuid: 'p1', message: { role: 'user', content: 'prompt 1' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [toolUse('t1', 'Edit', { file_path: '/w/a.ts' })] } },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: [result('t1', 'ok')] } },
    ])
    w.mtimeMs = 2
    isWritten = true
    await $.turn.complete({ answer: 'ok', durationMs: 2000, isAborted: false, turnId: 't1', reason: 'answer' } as any)
    // 記録を読んだので、編集したファイルまで分かる。
    const site = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const card = await cardIn(site, 0)
    expect(textOf(elementsOf(card).at(-1)!).trimEnd()).toBe('#1 prompt 1 · 2秒 · ツール 1 · 編集 1（a.ts）')
  })

  test('classic.SessionStart が届かなくても、/clear（session.end の clear）で並びを空にする', async ($, on) => {
    world(on, FIVE)
    place(on)
    on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/w/my.proj', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    expect((await labels($)).length).toBe(5)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    expect(await labels($)).toEqual([])
  })
})

describe('スラッシュコマンドとプロンプトの見分け', () => {
  test('/名前 のあとが空白か行末ならコマンド、/ で始まるだけの文はプロンプト', () => {
    for (const text of ['/compact', '/prompt-trail next', '/1', '/plugin enable a@b', '/reply-prism theme nord'])
      expect(isSlashCommand(text), text).toBe(true)
    for (const text of ['/1の方法で候補が入りました', '/Users/me/app を見て', '/ を打つと一覧が出る', '／1 全角', 'ふつうの文'])
      expect(isSlashCommand(text), text).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. 実在するコマンド名での判定・ターンが走るコマンド・飛び先
// ---------------------------------------------------------------------------

describe('コマンド名の判定（一覧があるとき・ないとき）', () => {
  test('/ のあとの最初の語を取る（plugin:name も、日本語名も）。あとが空白か行末でなければ語にならない', () => {
    expect(slashName('/code-review --comment')).toBe('code-review')
    expect(slashName('/notion:search 議事録')).toBe('notion:search')
    expect(slashName('/日報 今日')).toBe('日報')
    expect(slashName('/日報')).toBe('日報')
    expect(slashName('/Users/me/app を見て')).toBeUndefined()
    expect(slashName('/1の方法で')).toBe('1の方法で')
    expect(slashName('ふつうの文')).toBeUndefined()
  })

  test('一覧があれば、その中の名前のときだけコマンド（日本語名は拾い、/tmp を見て はプロンプト）', () => {
    const names = new Set(['日報', 'compact', 'notion:search', 'code-review'])
    for (const text of ['/日報 今日', '/日報', '/compact', '/notion:search 議事録', '/code-review --comment'])
      expect(isCommandText(text, names), text).toBe(true)
    for (const text of ['/tmp のログを見て', '/Users/me/app を見て', '/unknown', 'ふつうの文'])
      expect(isCommandText(text, names), text).toBe(false)
  })

  test('一覧が取れないとき（undefined）は、今までの正規表現の判定に戻る', () => {
    expect(isCommandText('/compact', undefined)).toBe(true)
    expect(isCommandText('/日報 今日', undefined)).toBe(false)
    expect(isCommandText('/1の方法で', undefined)).toBe(false)
  })

  test('記録のコマンドの行から、打った文を取り出す', () => {
    const row = (name: string, args: string) => `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`
    expect(commandRowText(row('code-review', '--comment'))).toBe('/code-review --comment')
    expect(commandRowText(row('notion:search', '議事録'))).toBe('/notion:search 議事録')
    expect(commandRowText(row('compact', ''))).toBe('/compact')
    expect(commandRowText('/compact')).toBeUndefined()
    expect(commandRowText('ふつうの文')).toBeUndefined()
  })
})

describe('コマンドの行の扱い（記録の印で決め、一覧は描かれた行の結び付けに使う）', () => {
  const commandRow = (name: string, args = '') => `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`
  const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra })
  const reply = (uuid: string, content: unknown[] = [{ type: 'text', text: 'ok' }]) => ({ type: 'assistant', uuid, message: { role: 'assistant', content } })
  // ターンが走るコマンド（展開の行 → 返事）、走らない組み込み（stdout の行）、走らない Mod のコマンド（system の local_command）、ふつうのプロンプト。
  const MIXED = jsonl([
    user('u1', 'first'),
    reply('a1'),
    user('c1', commandRow('code-review', '--comment'), { timestamp: '2026-10-05T00:00:00.000Z' }),
    user('m1', [{ type: 'text', text: 'Review the code ...' }], { isMeta: true }),
    reply('a2', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } }]),
    user('r1', [result('t1', 'ok')]),
    user('k1', '<local-command-caveat>Caveat: ...</local-command-caveat>', { isMeta: true }),
    user('c2', commandRow('compact')),
    user('o2', '<local-command-stdout>Compacted</local-command-stdout>'),
    user('k2', '<local-command-caveat>Caveat: ...</local-command-caveat>', { isMeta: true }),
    user('c3', commandRow('plugin', 'enable a@b')),
    user('o3', '<local-command-stdout>(no content)</local-command-stdout>'),
    { type: 'system', subtype: 'local_command', uuid: 'c4', content: commandRow('mymod', 'x') },
    user('c5', commandRow('notion:search', '議事録')),
    user('m5', 'Search Notion for ...', { isMeta: true }),
    reply('a5'),
    user('u2', '/tmp のログを見て'),
    reply('a6'),
  ])
  const railTexts = async ($: any) => {
    const rail = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane('dock', 40) })
    const found = (await rail.findAll({ type: 'Button' })).filter((n: FoundElement) => /^jump-/.test(String(n.key))).map((n: FoundElement) => String(n.props.label).replace(/^\s*[─━┆│┃]\s/, ''))
    await rail.unmount()
    return found
  }

  test('ターンが走るコマンドは打った文で並び、走らないもの（/compact・/plugin・Mod のコマンド）は並ばない。/tmp を見て はプロンプト', async ($, on) => {
    world(on, MIXED)
    mock.clock(on)
    // 一覧は見ない（取れなくても、記録の行の判定は同じ）。
    await resume($)
    await runCommand($, 'vertical')
    expect(await railTexts($)).toEqual(['first', '/code-review --comment', '/notion:search 議事録', '/tmp のログを見て'])
  })

  test('そのターンの時間・件数・色（編集）も、ほかのプロンプトと同じく付く', async ($, on) => {
    world(on, MIXED)
    mock.clock(on)
    await resume($)
    await runCommand($, 'horizontal')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const texts = (await band.findAll({ type: 'Text' })).map((t: FoundElement) => String(t.text))
    expect(texts.some(t => /\/code-review --comment · ツール 1 · 編集 1（a\.ts）/.test(t)), texts.join('|')).toBe(true)
    const strips = (await band.findAll({ type: 'Text' })).filter((t: FoundElement) => String(t.text).includes(STRIP))
    expect(strips.length).toBeGreaterThan(0)
  })

  test('記録の判定は、コマンドの一覧が変わっても（消えても・増えても・取れなくなっても）変わらない', async ($, on) => {
    world(on, MIXED)
    mock.clock(on)
    let list: { name: string }[] | 'fail' = [{ name: 'code-review' }, { name: 'notion:search' }, { name: 'compact' }]
    on('command.list', () => {
      if (list === 'fail') throw new Error('no list')
      return { value: list.map(c => ({ ...c, description: '', source: 'user' })) } as any
    })
    await resume($)
    await runCommand($, 'vertical')
    const expected = ['first', '/code-review --comment', '/notion:search 議事録', '/tmp のログを見て']
    expect(await railTexts($)).toEqual(expected)
    // コマンドが消えた（使ったあとで削除された）。
    list = []
    await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
    expect(await railTexts($)).toEqual(expected)
    // 一覧が取れない。
    list = 'fail'
    await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
    expect(await railTexts($)).toEqual(expected)
    // あとから増えた。
    list = [{ name: 'tmp' }, { name: '日報' }]
    await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
    expect(await railTexts($)).toEqual(expected)
  })

  test('描かれた行: 一覧にある名前（日本語名も）は並べず、無い名前は並べる。途中で足したコマンドは、取り直して追従する', async ($, on) => {
    const w = world(on, jsonl([user('u1', 'first')]))
    const clock = mock.clock(on)
    let list = [{ name: 'compact' }]
    on('command.list', () => ({ value: list.map(c => ({ ...c, description: '', source: 'user' })) }) as any)
    await resume($)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    // 一覧にある /compact は並べない。
    await drawRow($, 'd1', '/compact')
    // 途中で /日報 が増えた: 一覧に無い間に描かれても、取り直して一覧に入っていればコマンド扱いで並べない。
    list = [{ name: 'compact' }, { name: '日報' }]
    await drawRow($, 'd2', '/日報 今日')
    await clock.settle()
    expect(await railTexts($)).toEqual(['first'])
    // 一覧に無い /tmp を見て は、取り直してもなければプロンプトとして並ぶ。
    await drawRow($, 'd3', '/tmp のログを見て')
    await clock.settle()
    expect(await railTexts($)).toEqual(['first', '/tmp のログを見て'])
    // その /日報 が消えた（Mod が解除した）あとでも、すでに並べた行は変わらない。
    list = [{ name: 'compact' }]
    await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
    expect(await railTexts($)).toEqual(['first', '/tmp のログを見て'])
    expect(w.toasts).toEqual([])
  })

  test('一覧が取れないときは、/名前 のあとが空白か行末なら（正規表現で）コマンド、そうでなければプロンプト', async ($, on) => {
    world(on, jsonl([user('u1', 'first')]))
    const clock = mock.clock(on)
    on('command.list', () => {
      throw new Error('no list')
    })
    await resume($)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
    await runCommand($, 'vertical')
    await drawRow($, 'd1', '/compact')
    await drawRow($, 'd2', '/1の方法で候補が入りました')
    await clock.settle()
    expect(await railTexts($)).toEqual(['first', '/1の方法で候補が入りました'])
  })

  test('記録の索引: コマンドの最初の返事の行が分かる', () => {
    const rows = JSON.parse(`[${MIXED.split('\n').join(',')}]`)
    const index = indexRows(rows)
    expect(index.prompts.map(p => p.text)).toEqual(['first', '/code-review --comment', '/notion:search 議事録', '/tmp のログを見て'])
    expect(index.prompts.map(p => p.command ?? false)).toEqual([false, true, true, false])
    expect([...firstReplies(index)]).toEqual([['u1', 'a1'], ['c1', 'a2'], ['c5', 'a5'], ['u2', 'a6']])
  })

  // Mod が自分の ui.scroll に答える形はテストの engine に無い（upstream.test.tsx の NOT_DRAWN の注意書きと同じ）ので、
  // 飛び先の決め方は純粋な関数（bindCommandRows・jumpTargets）で見て、実際のスクロールは画面で確かめる。
  describe('押したときの飛び先', () => {
    const cmd = (id: string, text = '/code-review --comment'): Entry => ({ id, text, command: true })
    const plain = (id: string, text: string): Entry => ({ id, text })

    test('描かれた ❯ /code-review … の行を、文と順番（同じ文の n 番目）で記録の行に結び付ける', () => {
      const entries = [plain('u1', 'first'), cmd('c1'), cmd('c2'), cmd('c3', '/日報 今日')]
      const rows = new Map([
        ['x-1', '/code-review --comment'],
        ['x-n', '/日報 今日'],
        ['x-2', '/code-review --comment'],
        ['x-other', '/other'],
      ])
      expect([...bindCommandRows(entries, rows)]).toEqual([
        ['c1', 'x-1'],
        ['c2', 'x-2'],
        ['c3', 'x-n'],
      ])
      // まだ 1 つしか描かれていなければ、1 つ目だけが結び付く。
      expect([...bindCommandRows(entries, new Map([['x-1', '/code-review --comment']]))]).toEqual([['c1', 'x-1']])
    })

    test('結び付いた行へ。なければ直後の返事の行（描かれた id があればそれ）。どちらも無ければ記録の行（点線になる）', () => {
      const replies = new Map([['c1', 'a1'], ['c2', 'a2']])
      const drawnReplies = new Map([['a2', 'a2-drawn']])
      const bound = new Map([['c1', 'x-1']])
      expect(jumpTargets(cmd('c1'), bound, replies, drawnReplies)).toEqual(['x-1', 'a1'])
      expect(jumpTargets(cmd('c2'), bound, replies, drawnReplies)).toEqual(['a2-drawn'])
      expect(jumpTargets(cmd('c3'), bound, replies, drawnReplies)).toEqual(['c3'])
      // ふつうのプロンプトは、描かれた行（なければ自分の id）。
      expect(jumpTargets(plain('u1', 'first'), new Map([['u1', 'u1-drawn']]), replies, drawnReplies)).toEqual(['u1-drawn'])
    })
  })
})

describe('サブエージェントの報告は履歴に出さない', () => {
  test('<agent-message> と <cross-session-message> で始まるユーザーの行はプロンプトにしない', () => {
    const at = (n: number) => `2026-10-05T10:00:0${n}.000Z`
    const rows = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(1), message: { role: 'user', content: '直して' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: '任せました' }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at(3), message: { role: 'user', content: '<agent-message from="x1">\n報告です\n</agent-message>' } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: at(4), message: { role: 'user', content: '<cross-session-message from="s1">やあ</cross-session-message>' } },
    ]
    const index = indexRows(rows)

    expect(index.prompts.map(p => p.text)).toEqual(['直して'])
  })
})
