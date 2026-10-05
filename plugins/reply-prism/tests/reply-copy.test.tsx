// 返事まるごとコピー（hooks/reply.ts と、返事の最後の「コピー:」の行）のテスト。
//
//   claude plugin test plugins/reply-prism
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { HTML_PREFIX, PASTEBOARD_ARGV, PASTEBOARD_SCRIPT, pasteboardInput } from '../hooks/clipboard'
import { rewriteMarks } from '../hooks/mark'
import type { TranscriptRow } from '../hooks/reply'
import {
  convertReply,
  convertReplySlackRich,
  escapeHtml,
  findReply,
  splitReplies,
  toReplyGitHub,
  toReplyMarkdown,
  toReplyNotion,
  toReplySlack,
  toReplySlackHtml, SLACK_BLOCK_GAP,
  toReplySlackPlain,
} from '../hooks/reply'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

type Dollar = Parameters<TestBody>[0]

// ---------------------------------------------------------------------------
// 見本: 見出し・太字・斜体・取り消し・インラインコード・リンク・入れ子リスト・番号リスト・表・コード（言語つき）・
// mermaid・囲み・引用・==…==・日本語を 1 つに。

const SAMPLE = [
  '## 調査結果',
  '',
  '**原因**は _設定漏れ_ で、~~前の推測~~は外れ。`config.yml` の ==本番の値を上書きする== 箇所がある。詳しくは [手順書](https://example.com/doc) を参照。',
  '',
  '- 確認したこと',
  '  - ログの **ERROR** 行',
  '  - 設定ファイル',
  '- 直すこと',
  '',
  '1. 設定を直す',
  '2. 再起動する',
  '',
  '| 項目 | 件数 |',
  '| :--- | ---: |',
  '| 成功 | 10 |',
  '| ==失敗== | 2 |',
  '',
  '```ts',
  'const a = 1 // ==そのまま==',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '> [!WARNING]',
  '> 再起動の前に ==バックアップ== を取る。',
  '',
  '> 引用の 1 行目',
  '> 2 行目',
  '',
  '#### 補足',
  '',
  '以上。',
].join('\n')

/** 見本のうち、どの形式でも書かれたままの行（コード・mermaid）。 */
const CODE = ['```ts', 'const a = 1 // ==そのまま==', '```', '', '```mermaid', 'flowchart LR', '  A --> B', '```']

describe('返事まるごとコピー: 形式ごとの書き直し', () => {
  test('Markdown: 印は外し、囲みは > **Warning** に。ほかは書かれたまま', async () => {
    expect(toReplyMarkdown(SAMPLE)).toBe(
      [
        '## 調査結果',
        '',
        '**原因**は _設定漏れ_ で、~~前の推測~~は外れ。`config.yml` の 本番の値を上書きする 箇所がある。詳しくは [手順書](https://example.com/doc) を参照。',
        '',
        '- 確認したこと',
        '  - ログの **ERROR** 行',
        '  - 設定ファイル',
        '- 直すこと',
        '',
        '1. 設定を直す',
        '2. 再起動する',
        '',
        '| 項目 | 件数 |',
        '| :--- | ---: |',
        '| 成功 | 10 |',
        '| 失敗 | 2 |',
        '',
        ...CODE,
        '',
        '> **Warning**',
        '> 再起動の前に バックアップ を取る。',
        '',
        '> 引用の 1 行目',
        '> 2 行目',
        '',
        '#### 補足',
        '',
        '以上。',
      ].join('\n'),
    )
  })

  test('GitHub: 囲み・表・mermaid・言語名はそのまま、印は太字', async () => {
    expect(toReplyGitHub(SAMPLE)).toBe(
      [
        '## 調査結果',
        '',
        '**原因**は _設定漏れ_ で、~~前の推測~~は外れ。`config.yml` の **本番の値を上書きする** 箇所がある。詳しくは [手順書](https://example.com/doc) を参照。',
        '',
        '- 確認したこと',
        '  - ログの **ERROR** 行',
        '  - 設定ファイル',
        '- 直すこと',
        '',
        '1. 設定を直す',
        '2. 再起動する',
        '',
        '| 項目 | 件数 |',
        '| :--- | ---: |',
        '| 成功 | 10 |',
        '| **失敗** | 2 |',
        '',
        ...CODE,
        '',
        '> [!WARNING]',
        '> 再起動の前に **バックアップ** を取る。',
        '',
        '> 引用の 1 行目',
        '> 2 行目',
        '',
        '#### 補足',
        '',
        '以上。',
      ].join('\n'),
    )
  })

  test('Slack: mrkdwn の記法・• のリスト・桁を揃えた表・言語名なしのコード・絵文字つきの囲み。リンクは text (url)', async () => {
    expect(toReplySlack(SAMPLE)).toBe(
      [
        '*調査結果*',
        '',
        '*原因*は _設定漏れ_ で、~前の推測~は外れ。`config.yml` の *本番の値を上書きする* 箇所がある。詳しくは 手順書 (https://example.com/doc) を参照。',
        '',
        '• 確認したこと',
        '    • ログの *ERROR* 行',
        '    • 設定ファイル',
        '• 直すこと',
        '',
        '1. 設定を直す',
        '2. 再起動する',
        '',
        '```',
        '項目  件数',
        '----  ----',
        '成功    10',
        '失敗     2',
        '```',
        '',
        '```',
        'const a = 1 // ==そのまま==',
        '```',
        '',
        '```',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '> :warning: *Warning*',
        '> 再起動の前に *バックアップ* を取る。',
        '',
        '> 引用の 1 行目',
        '> 2 行目',
        '',
        '*補足*',
        '',
        '以上。',
      ].join('\n'),
    )
  })

  test('Notion: 囲みは絵文字とラベルの引用、印は太字、#### 以下は太字の 1 行。コード・mermaid の言語名は残す', async () => {
    expect(toReplyNotion(SAMPLE)).toBe(
      [
        '## 調査結果',
        '',
        '**原因**は _設定漏れ_ で、~~前の推測~~は外れ。`config.yml` の **本番の値を上書きする** 箇所がある。詳しくは [手順書](https://example.com/doc) を参照。',
        '',
        '- 確認したこと',
        '  - ログの **ERROR** 行',
        '  - 設定ファイル',
        '- 直すこと',
        '',
        '1. 設定を直す',
        '2. 再起動する',
        '',
        '| 項目 | 件数 |',
        '| :--- | ---: |',
        '| 成功 | 10 |',
        '| **失敗** | 2 |',
        '',
        ...CODE,
        '',
        '> ⚠️ **Warning**',
        '> 再起動の前に **バックアップ** を取る。',
        '',
        '> 引用の 1 行目',
        '> 2 行目',
        '',
        '**補足**',
        '',
        '以上。',
      ].join('\n'),
    )
  })

  test('囲みの種類ごとのラベルと絵文字。マーカーと同じ行の文は次の行に', async () => {
    const levels = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
    const alerts = levels.map(l => `> [!${l}] 一言`).join('\n\n')
    expect(toReplySlack(alerts).split('\n\n').map(b => b.split('\n')[0])).toEqual([
      '> :information_source: *Note*',
      '> :bulb: *Tip*',
      '> :exclamation: *Important*',
      '> :warning: *Warning*',
      '> :octagonal_sign: *Caution*',
    ])
    expect(toReplyNotion(alerts).split('\n\n')).toEqual(['> ℹ️ **Note**\n> 一言', '> 💡 **Tip**\n> 一言', '> ❗ **Important**\n> 一言', '> ⚠️ **Warning**\n> 一言', '> 🛑 **Caution**\n> 一言'])
    expect(toReplyMarkdown('> [!tip] 一言')).toBe('> **Tip**\n> 一言')
    // 引用の途中の [!NOTE] は囲みではない。
    expect(toReplyMarkdown('> 前の行\n> [!NOTE] 途中')).toBe('> 前の行\n> [!NOTE] 途中')
  })

  test('コードの中の == と囲みらしい行・見出しらしい行は書き直さない', async () => {
    const text = ['```md', '> [!NOTE]', '#### 見出し', '==印==', '```', '`a == b` と ==印=='].join('\n')
    expect(toReplyGitHub(text)).toBe(['```md', '> [!NOTE]', '#### 見出し', '==印==', '```', '`a == b` と **印**'].join('\n'))
    expect(toReplyNotion(text)).toBe(['```md', '> [!NOTE]', '#### 見出し', '==印==', '```', '`a == b` と **印**'].join('\n'))
    expect(toReplySlack(text)).toBe(['```', '> [!NOTE]', '#### 見出し', '==印==', '```', '', '`a == b` と *印*'].join('\n'))
  })

  test('Slack: 素の URL はそのまま、太字の中の印・見出しの中の太字は * を重ねない、番号の ) も残す', async () => {
    expect(toReplySlack('見る https://example.com/a と **太字の ==中== も**')).toBe('見る https://example.com/a と *太字の 中 も*')
    expect(toReplySlack('### **大事** な点')).toBe('*大事 な点*')
    expect(toReplySlack('1) 一つ目\n2) 二つ目\n   - 下')).toBe('1) 一つ目\n2) 二つ目\n    • 下')
    expect(toReplySlack('---')).toBe('────────')
  })

  test('印の中に ** があれば印を外すだけ（**** にしない）。表の行はセルをまたがない', async () => {
    expect(rewriteMarks('==**a**==', '**')).toBe('**a**')
    expect(rewriteMarks('| ==a | b== |', '**')).toBe('| ==a | b== |')
    expect(rewriteMarks('| ==a== | b |', '**')).toBe('| **a** | b |')
  })

  test('返事のブロックをつなぐ: 形式ごとに書き直して空行 1 つで。閉じ忘れたコードは次のブロックに漏れない', async () => {
    expect(convertReply('github', ['まず ==確認== します。\n', '\n```sh\nls', '終わり ==済=='])).toBe('まず **確認** します。\n\n```sh\nls\n\n終わり **済**')
    expect(convertReply('slack', ['**A**', '', 'B'])).toBe('*A*\n\nB')
  })
})

// ---------------------------------------------------------------------------
describe('返事まるごとコピー: 返事を集める', () => {
  const ROWS: TranscriptRow[] = [
    { role: 'user', text: '一つ目の依頼' },
    { role: 'assistant', text: '了解。' },
    { role: 'user', text: '二つ目の依頼' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: '調べます。' },
    { role: 'assistant', text: '' },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', text: '結果はこう。' },
  ]

  test('依頼ごとに分け、ツールの結果・考えるだけの行は区切りにも文にもならない', async () => {
    expect(splitReplies(ROWS)).toEqual([['了解。'], ['調べます。', '結果はこう。']])
  })

  test('ブロックの入る返事・最後か・最後の返事か', async () => {
    expect(findReply(ROWS, '調べます。')).toEqual({ texts: ['調べます。', '結果はこう。'], isLast: false, isLatest: true })
    expect(findReply(ROWS, '  結果はこう。\n')).toEqual({ texts: ['調べます。', '結果はこう。'], isLast: true, isLatest: true })
    expect(findReply(ROWS, '了解。')).toEqual({ texts: ['了解。'], isLast: true, isLatest: false })
    expect(findReply(ROWS, '無い文')).toBeUndefined()
    expect(findReply(ROWS, '')).toBeUndefined()
  })

  test('同じ文が何度も出てきたら一番新しい返事。描く側が一部を隠した文は含むかで探す', async () => {
    const rows: TranscriptRow[] = [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: '完了。' },
      { role: 'user', text: 'b' },
      { role: 'assistant', text: '直した。' },
      { role: 'assistant', text: '完了。' },
      { role: 'user', text: 'c' },
    ]
    expect(findReply(rows, '完了。')).toEqual({ texts: ['直した。', '完了。'], isLast: true, isLatest: false })
    expect(findReply([{ role: 'user', text: 'a' }, { role: 'assistant', text: '<context>x</context>\n本文' }], '本文')?.isLast).toBe(true)
    // 1 行に 2 つのブロックがあるとき、行の前のほうのブロックは最後ではない。
    expect(findReply([{ role: 'user', text: 'a' }, { role: 'assistant', text: '前半\n後半' }], '前半')?.isLast).toBe(false)
  })
})

// ---------------------------------------------------------------------------
const block = (text: string, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal', requestId = 'msg-1') => ({
  plugin: 'reply-prism',
  surface,
  component: 'AssistantMessage' as const,
  props: { text, isFirstOfReply: true },
  requestId,
  viewport: { columns: 160, rows: 60 },
})

/** 会話（`$.session.messages()` の答え）を差し替えられるようにする。 */
const transcript = (on: On, initial: TranscriptRow[]) => {
  const state = { rows: initial }
  // 答えの型は SessionMessage[]（toolResults の中身はここでは見ないので省く）。
  on('session.messages', () => ({ value: state.rows.map(r => ({ toolUses: [], ...r })) }) as never)
  return state
}

const capture = (on: On) => {
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { copied, toasts }
}

/**
 * `$.process.run` の答え。`uname -s` には `os` を、osascript には `osascript`（終了コード。'missing' なら起動できない）を返す。
 * 呼ばれた argv と標準入力を並べて返す。
 */
const host = (on: On, os: string, osascript: number | 'missing' = 0) => {
  const runs: { argv: string[]; stdin?: string }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    const exit = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'execution error' : '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'uname') return exit(`${os}\n`)
    if (e.argv[0] === 'osascript' && osascript !== 'missing') return exit(osascript === 0 ? 'ok\n' : '', osascript)
    throw new Error(`${e.argv[0]}: not found`)
  })
  return runs
}

const turnEvents = (on: On) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const startTurn = ($: Dollar) => $.turn.start({ text: '依頼', turnId: 't1' })
const completeTurn = ($: Dollar, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId ? { agentId } : {}) })

const ROWS: TranscriptRow[] = [
  { role: 'user', text: 'ログを調べて' },
  { role: 'assistant', text: '調べます。' },
  { role: 'assistant', text: '' },
  { role: 'user', text: '', toolResults: [{}] },
  { role: 'assistant', text: '原因は ==設定漏れ== です。\n\n- 直す' },
]
const LAST = '原因は ==設定漏れ== です。\n\n- 直す'

const rowButtons = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: string; props: { label?: unknown; variant?: unknown } }[]> }) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('replycopy.'))

describe('返事まるごとコピー: 返事の最後の「コピー:」の行', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`返事の最後のテキストブロックの下にだけ出し、押すと返事全体をその形でコピーする（${surface}、macOS 以外）`, async ($, on) => {
      transcript(on, ROWS)
      host(on, 'Linux')
      const { copied, toasts } = capture(on)
      const first = await $.ui.mount(block('調べます。', surface, 'a1'))
      expect(await rowButtons(first)).toHaveLength(0)
      expect(await first.find({ type: 'Text', text: /^コピー:$/ })).toBeUndefined()
      await first.unmount()

      const last = await $.ui.mount(block(LAST, surface, 'a2'))
      const buttons = await rowButtons(last)
      expect(buttons.map(b => b.props.label)).toEqual(['Markdown', 'GitHub', 'Slack', 'Notion'])
      expect(buttons.map(b => b.key)).toEqual(['replycopy.markdown', 'replycopy.github', 'replycopy.slack', 'replycopy.notion'])
      expect(buttons.every(b => b.props.variant === 'primary')).toBe(true)
      expect((await last.find({ type: 'Text', text: /^コピー:$/ }))?.props.dimColor).toBe(true)
      for (const b of buttons) await last.press({ key: b.key! })
      expect(copied).toEqual([
        '調べます。\n\n原因は 設定漏れ です。\n\n- 直す',
        '調べます。\n\n原因は **設定漏れ** です。\n\n- 直す',
        '調べます。\n\n原因は *設定漏れ* です。\n\n• 直す',
        '調べます。\n\n原因は **設定漏れ** です。\n\n- 直す',
      ])
      expect(toasts).toEqual(['Markdown でコピーしました', 'GitHub 用にコピーしました', 'Slack 用にコピーしました（文字だけ）', 'Notion 用にコピーしました'])
      await last.unmount()
    })
  }

  test('ターンの途中は出さず、ターンが終わると最後のテキストブロックの下に出る（前のブロックからは消える）', async ($, on) => {
    turnEvents(on)
    const convo = transcript(on, [{ role: 'user', text: 'ログを調べて' }])
    await startTurn($)
    convo.rows = ROWS.slice(0, 2)
    const first = await $.ui.mount(block('調べます。', 'terminal', 'a1'))
    expect(await rowButtons(first)).toHaveLength(0)
    convo.rows = ROWS
    const last = await $.ui.mount(block(LAST, 'terminal', 'a2'))
    expect(await rowButtons(last)).toHaveLength(0)
    await completeTurn($, LAST)
    expect(await rowButtons(last)).toHaveLength(4)
    expect(await rowButtons(first)).toHaveLength(0)
    await first.unmount()
    await last.unmount()
  })

  test('ターンの途中に描いて出さなかったブロックも、ターンが終わってそれが最後なら出る', async ($, on) => {
    turnEvents(on)
    transcript(on, ROWS)
    await startTurn($)
    const last = await $.ui.mount(block(LAST, 'terminal', 'a2'))
    expect(await rowButtons(last)).toHaveLength(0)
    // サブエージェントのターンの終わりでは変わらない。
    await completeTurn($, 'sub', 'agent-1')
    expect(await rowButtons(last)).toHaveLength(0)
    await completeTurn($, LAST)
    expect(await rowButtons(last)).toHaveLength(4)
    await last.unmount()
  })

  test('次の依頼を送ると、前の返事は終わったものとして出したまま', async ($, on) => {
    turnEvents(on)
    const convo = transcript(on, ROWS)
    const last = await $.ui.mount(block(LAST, 'terminal', 'a2'))
    expect(await rowButtons(last)).toHaveLength(4)
    convo.rows = [...ROWS, { role: 'user', text: '次の依頼' }]
    await startTurn($)
    expect(await rowButtons(last)).toHaveLength(4)
    await last.unmount()
  })

  test('会話に見つからないブロックには出さない（返事が決められないため）', async ($, on) => {
    transcript(on, ROWS)
    const ui = await $.ui.mount(block('会話に無い文'))
    expect(await rowButtons(ui)).toHaveLength(0)
    await ui.unmount()
  })

  test('「開く:」の行の下に並び、表・コードのコピーボタンとはぶつからない', async ($, on) => {
    mockSession(on)
    const text = '見る: src/app.ts:3\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\nls\n```'
    transcript(on, [{ role: 'user', text: '依頼' }, { role: 'assistant', text }])
    host(on, 'Linux')
    const { copied } = capture(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(block(text))
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(keys).toEqual(['copy1.markdown', 'copy1.tsv', 'copy1.slack', 'copy2', 'open:3:0:/work/app/src/app.ts', 'replycopy.markdown', 'replycopy.github', 'replycopy.slack', 'replycopy.notion'])
    await ui.press({ key: 'copy1.tsv' })
    await ui.press({ key: 'replycopy.slack' })
    expect(copied).toEqual(['a\tb\n1\t2', '見る: src/app.ts:3\n\n```\na  b\n-  -\n1  2\n```\n\n```\nls\n```'])
    await ui.unmount()
  })

  test('会話が書き換わったら（/rewind・/compact・再開）、覚えていた会話を捨てて読み直す', async ($, on) => {
    const state = transcript(on, ROWS)
    const ui = await $.ui.mount(block(LAST))
    expect(await rowButtons(ui)).toHaveLength(4)
    await ui.unmount()
    // その返事ごと巻き戻された。覚えの有効な間隔を過ぎたら、同じ文でも出さない。
    state.rows = [{ role: 'user', text: 'ログを調べて' }, { role: 'assistant', text: '別の返事' }]
    await new Promise(done => setTimeout(done, 1100))
    const again = await $.ui.mount(block(LAST, 'terminal', 'msg-2'))
    expect(await rowButtons(again)).toHaveLength(0)
    await again.unmount()
  })

  test('copyButtons: false でも出す（表・コードのコピーボタンだけ消える）', { options: { copyButtons: false } }, async ($, on) => {
    transcript(on, ROWS)
    const ui = await $.ui.mount(block(LAST))
    expect(await rowButtons(ui)).toHaveLength(4)
    await ui.unmount()
  })

  test('replyCopy: false なら出さず、会話も読まない', { options: { replyCopy: false } }, async ($, on) => {
    let reads = 0
    on('session.messages', () => {
      reads++
      return { value: [] } as never
    })
    const ui = await $.ui.mount(block(LAST))
    expect(await rowButtons(ui)).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^コピー:$/ })).toBeUndefined()
    expect(reads).toBe(0)
    await ui.unmount()
  })

  test('replyCopyFormats で並びと形式を選べる。知らない名前は捨て、空なら 4 つとも', { options: { replyCopyFormats: 'Slack, notion,excel,slack' } }, async ($, on) => {
    transcript(on, ROWS)
    const ui = await $.ui.mount(block(LAST))
    expect((await rowButtons(ui)).map(b => b.props.label)).toEqual(['Slack', 'Notion'])
    await ui.unmount()
  })

  test('replyCopyFormats が空なら 4 つとも', { options: { replyCopyFormats: '' } }, async ($, on) => {
    transcript(on, ROWS)
    const ui = await $.ui.mount(block(LAST))
    expect((await rowButtons(ui)).map(b => b.props.label)).toEqual(['Markdown', 'GitHub', 'Slack', 'Notion'])
    await ui.unmount()
  })

  test('/reply-prism demo（コマンドの出力）には出さない', async ($, on) => {
    transcript(on, ROWS)
    const ui = await $.ui.mount({ plugin: 'reply-prism', surface: 'terminal', component: 'CommandOutput', props: { command: 'reply-prism', args: 'demo', text: LAST, isErrored: false }, requestId: 'cmd-1', viewport: { columns: 160, rows: 60 } })
    expect(await rowButtons(ui)).toHaveLength(0)
    await ui.unmount()
  })
})

// ---------------------------------------------------------------------------
describe('返事まるごとコピー: Slack の書式付き（HTML とプレーンテキスト）', () => {
  test('HTML: 見出しは太字の段落、<b> <i> <s> <code> <a>、入れ子の <ul> と <ol>、表・コード・mermaid は <pre>、囲みは絵文字と太字のラベルの引用', async () => {
    expect(toReplySlackHtml(SAMPLE)).toBe(
      [
        '<p><b>調査結果</b></p>',
        '<p><b>原因</b>は <i>設定漏れ</i> で、<s>前の推測</s>は外れ。<code>config.yml</code> の <b>本番の値を上書きする</b> 箇所がある。詳しくは <a href="https://example.com/doc">手順書</a> を参照。</p>',
        '<ul><li>確認したこと<ul><li>ログの <b>ERROR</b> 行</li><li>設定ファイル</li></ul></li><li>直すこと</li></ul>',
        '<ol><li>設定を直す</li><li>再起動する</li></ol>',
        '<pre>項目  件数\n----  ----\n成功    10\n失敗     2</pre>',
        '<pre>const a = 1 // ==そのまま==</pre>',
        '<pre>flowchart LR\n  A --&gt; B</pre>',
        '<blockquote>⚠️ <b>Warning</b><br>再起動の前に <b>バックアップ</b> を取る。</blockquote>',
        '<blockquote>引用の 1 行目<br>2 行目</blockquote>',
        '<p><b>補足</b></p>',
        '<p>以上。</p>',
      ].join(SLACK_BLOCK_GAP),
    )
  })

  test('HTML: 特殊文字はすべてエスケープする（文・コード・リンクの URL と文字・表）。http(s)・mailto 以外のリンクは文字にする', async () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
    const text = [
      `a < b && "c" 'd' <script>x</script>`,
      '',
      '`<b>` [x<y](https://e.com/?a=1&b="2") [bad](javascript:alert) [m](mailto:a@example.com)',
      '',
      '```html',
      '<div>&amp;</div>',
      '```',
      '',
      '| <a> | b&c |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n')
    expect(toReplySlackHtml(text)).toBe(
      [
        '<p>a &lt; b &amp;&amp; &quot;c&quot; &#39;d&#39; &lt;script&gt;x&lt;/script&gt;</p>',
        '<p><code>&lt;b&gt;</code> <a href="https://e.com/?a=1&amp;b=&quot;2&quot;">x&lt;y</a> bad (javascript:alert) <a href="mailto:a@example.com">m</a></p>',
        '<pre>&lt;div&gt;&amp;amp;&lt;/div&gt;</pre>',
        '<pre>&lt;a&gt;  b&amp;c\n---  ---\n1    2</pre>',
      ].join(SLACK_BLOCK_GAP),
    )
  })

  test('HTML: リストの深さが飛んでも 1 段ずつ、記号と番号が入れ替われば別のリスト、1 以外で始まる番号は start', async () => {
    expect(toReplySlackHtml('- a\n    - deep\n- b\n1. x\n2. y')).toBe('<ul><li>a<ul><li>deep</li></ul></li><li>b</li></ul><ol><li>x</li><li>y</li></ol>')
    expect(toReplySlackHtml('5. five\n6. six\n   - sub\n7. seven')).toBe('<ol start="5"><li>five</li><li>six<ul><li>sub</li></ul></li><li>seven</li></ol>')
    expect(toReplySlackHtml('- a\n  1. one\n  - dot')).toBe('<ul><li>a<ol><li>one</li></ol><ul><li>dot</li></ul></li></ul>')
  })

  test('HTML: 段落の改行は <br>、見出しの中の太字・太字の中の印は <b> を重ねない、囲みの種類ごとの絵文字、区切り線', async () => {
    expect(toReplySlackHtml('一行目\n二行目')).toBe('<p>一行目<br>二行目</p>')
    expect(toReplySlackHtml('### **大事** な点')).toBe('<p><b>大事 な点</b></p>')
    expect(toReplySlackHtml('**太字の ==中== も**')).toBe('<p><b>太字の 中 も</b></p>')
    expect(toReplySlackHtml('> [!TIP] 一言\n> 二言')).toBe('<blockquote>💡 <b>Tip</b><br>一言<br>二言</blockquote>')
    expect(toReplySlackHtml('> [!CAUTION]')).toBe('<blockquote>🛑 <b>Caution</b></blockquote>')
    expect(toReplySlackHtml('---')).toBe('<p>────────</p>')
    expect(toReplySlackHtml('見る https://example.com/a')).toBe('<p>見る <a href="https://example.com/a">https://example.com/a</a></p>')
  })

  test('プレーンテキスト: 書式の記号を外し、リンクは text (url)、リストは •、コード・表は中身だけ、引用・囲みは > ', async () => {
    expect(toReplySlackPlain(SAMPLE)).toBe(
      [
        '調査結果',
        '',
        '原因は 設定漏れ で、前の推測は外れ。config.yml の 本番の値を上書きする 箇所がある。詳しくは 手順書 (https://example.com/doc) を参照。',
        '',
        '• 確認したこと',
        '    • ログの ERROR 行',
        '    • 設定ファイル',
        '• 直すこと',
        '',
        '1. 設定を直す',
        '2. 再起動する',
        '',
        '項目  件数',
        '----  ----',
        '成功    10',
        '失敗     2',
        '',
        'const a = 1 // ==そのまま==',
        '',
        'flowchart LR',
        '  A --> B',
        '',
        '> ⚠️ Warning',
        '> 再起動の前に バックアップ を取る。',
        '',
        '> 引用の 1 行目',
        '> 2 行目',
        '',
        '補足',
        '',
        '以上。',
      ].join('\n'),
    )
    // エスケープはしない（HTML ではない）。
    expect(toReplySlackPlain('a < b & `<c>`')).toBe('a < b & <c>')
  })

  test('返事のブロックをつなぐ: HTML は空の段落で区切り、プレーンテキストは空行 1 つで', async () => {
    expect(convertReplySlackRich(['**A**\n', '', '- b'])).toEqual({ html: '<p><b>A</b></p><p><br></p><ul><li>b</li></ul>', plain: 'A\n\n• b' })
  })

  test('osascript の argv と標準入力: JXA で public.html と public.utf8-plain-text を書く。中身は argv に入れない', async () => {
    expect(PASTEBOARD_ARGV).toEqual(['osascript', '-l', 'JavaScript', '-e', PASTEBOARD_SCRIPT])
    expect(PASTEBOARD_SCRIPT).toContain("ObjC.import('AppKit');")
    expect(PASTEBOARD_SCRIPT).toContain('fileHandleWithStandardInput')
    expect(PASTEBOARD_SCRIPT).toContain('clearContents')
    expect(PASTEBOARD_SCRIPT).toContain("$('public.html')")
    expect(PASTEBOARD_SCRIPT).toContain("$('public.utf8-plain-text')")
    expect(JSON.parse(pasteboardInput({ html: '<b>"x"</b>', plain: 'x' }))).toEqual({ html: `${HTML_PREFIX}<b>"x"</b>`, plain: 'x' })
  })
})

describe('返事まるごとコピー: Slack のボタン（書式付きと文字だけ）', () => {
  const RICH = convertReplySlackRich(ROWS.filter(r => r.role === 'assistant' && r.text !== '').map(r => r.text))
  const MRKDWN = '調べます。\n\n原因は *設定漏れ* です。\n\n• 直す'

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`macOS: osascript で HTML とプレーンテキストを入れ、$.ui.copy は使わない。OS の判定は 1 回だけ（${surface}）`, async ($, on) => {
      transcript(on, ROWS)
      const runs = host(on, 'Darwin')
      const { copied, toasts } = capture(on)
      const ui = await $.ui.mount(block(LAST, surface))
      await ui.press({ key: 'replycopy.slack' })
      await ui.press({ key: 'replycopy.slack' })
      expect(runs.map(r => r.argv[0])).toEqual(['uname', 'osascript', 'osascript'])
      expect(runs[0]!.argv).toEqual(['uname', '-s'])
      expect(runs[1]!.argv).toEqual([...PASTEBOARD_ARGV])
      expect(JSON.parse(runs[1]!.stdin!)).toEqual({ html: HTML_PREFIX + RICH.html, plain: RICH.plain })
      expect(RICH.html).toBe('<p>調べます。</p><p><br></p><p>原因は <b>設定漏れ</b> です。</p><p><br></p><ul><li>直す</li></ul>')
      expect(RICH.plain).toBe('調べます。\n\n原因は 設定漏れ です。\n\n• 直す')
      expect(copied).toEqual([])
      expect(toasts).toEqual(['Slack 用にコピーしました（書式付き）', 'Slack 用にコピーしました（書式付き）'])
      await ui.unmount()
    })
  }

  test('macOS で osascript が失敗したら $.ui.copy で mrkdwn の文字を入れ、トーストで分かる', async ($, on) => {
    transcript(on, ROWS)
    const runs = host(on, 'Darwin', 1)
    const { copied, toasts } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    await ui.press({ key: 'replycopy.slack' })
    expect(runs.map(r => r.argv[0])).toEqual(['uname', 'osascript'])
    expect(copied).toEqual([MRKDWN])
    expect(toasts).toEqual(['Slack 用にコピーしました（文字だけ）'])
    await ui.unmount()
  })

  test('macOS で osascript が無い（起動できない）ときも文字だけ', async ($, on) => {
    transcript(on, ROWS)
    host(on, 'Darwin', 'missing')
    const { copied, toasts } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    await ui.press({ key: 'replycopy.slack' })
    expect(copied).toEqual([MRKDWN])
    expect(toasts).toEqual(['Slack 用にコピーしました（文字だけ）'])
    await ui.unmount()
  })

  test('macOS 以外は osascript を呼ばずに文字だけ。判定は覚えて、2 回目は uname も呼ばない', async ($, on) => {
    transcript(on, ROWS)
    const runs = host(on, 'Linux')
    const { copied, toasts } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    await ui.press({ key: 'replycopy.slack' })
    await ui.press({ key: 'replycopy.slack' })
    expect(runs.map(r => r.argv)).toEqual([['uname', '-s']])
    expect(copied).toEqual([MRKDWN, MRKDWN])
    expect(toasts).toEqual(['Slack 用にコピーしました（文字だけ）', 'Slack 用にコピーしました（文字だけ）'])
    await ui.unmount()
  })

  test('uname が走らなければ文字だけで、判定は覚えない（次の押下でまた見る）', async ($, on) => {
    transcript(on, ROWS)
    const runs: string[] = []
    on('process.run', (_, e) => {
      runs.push(e.argv[0]!)
      throw new Error('cannot start')
    })
    const { copied } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    await ui.press({ key: 'replycopy.slack' })
    await ui.press({ key: 'replycopy.slack' })
    expect(runs).toEqual(['uname', 'uname'])
    expect(copied).toEqual([MRKDWN, MRKDWN])
    await ui.unmount()
  })

  test('SSH 越し（SSH_CONNECTION）は手元のクリップボードではないので、コマンドを走らせずに文字だけ', async ($, on) => {
    transcript(on, ROWS)
    mock.env(on, { SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22' })
    const runs = host(on, 'Darwin')
    const { copied, toasts } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    await ui.press({ key: 'replycopy.slack' })
    expect(runs).toEqual([])
    expect(copied).toEqual([MRKDWN])
    expect(toasts).toEqual(['Slack 用にコピーしました（文字だけ）'])
    await ui.unmount()
  })

  test('モバイルで押したときは Claude Code の機械のクリップボードに書かず、$.ui.copy で文字だけ', async ($, on) => {
    transcript(on, ROWS)
    const runs = host(on, 'Darwin')
    const { copied, toasts } = capture(on)
    const ui = await $.ui.mount(block(LAST, 'mobile'))
    await ui.press({ key: 'replycopy.slack' })
    expect(runs).toEqual([])
    expect(copied).toEqual([MRKDWN])
    expect(toasts).toEqual(['Slack 用にコピーしました（文字だけ）'])
    await ui.unmount()
  })

  test('Slack 以外の形式は osascript を使わない', async ($, on) => {
    transcript(on, ROWS)
    const runs = host(on, 'Darwin')
    const { copied } = capture(on)
    const ui = await $.ui.mount(block(LAST))
    for (const format of ['markdown', 'github', 'notion']) await ui.press({ key: `replycopy.${format}` })
    expect(runs).toEqual([])
    expect(copied).toHaveLength(3)
    await ui.unmount()
  })
})

const mockSession = (on: On) => {
  mock.env(on, { HOME: '/home/me' })
  on('fs.exists', () => ({ value: true }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.start', () => ({ cwd: '/work/app' }))
}
