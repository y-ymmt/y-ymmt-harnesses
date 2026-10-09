// reply-prism で足した 5 つの機能のテスト（本家から引き継いだテストは他のファイル）。
//
//   claude plugin test plugins/reply-prism
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { buildDanger, dangerRanges, parseWords } from '../hooks/danger'
import { showcaseText } from '../hooks/help'
import { DANGER_HINT, findMarks, markLines, stripMarks, stripTable } from '../hooks/mark'
import { parse } from '../hooks/markdown'
import { editorUrl, isPathLike, openKey, openLabel, parseOpenKey, parseUrlKey, resolvePath, splitTarget, urlKey, urlLabel } from '../hooks/paths'
import { columnKind, nextSort, parseDate, parseNumber, sortOrder, toMarkdown, toSlack, toTsv } from '../hooks/table'
import { mermaidText } from '../hooks/mermaid'
import { width } from '../hooks/width'
import { EXISTS_LIMIT, existingFiles, makeExpandedCalls, type ExistsCache } from '../hooks/register'

type Dollar = Parameters<TestBody>[0]

const CWD = '/work/example-app'
const HOME = '/home/me'
const RED = '#d20f39'

const reply = (text: string, surface: 'terminal' | 'desktop' = 'terminal', requestId = 'msg-1') => ({
  plugin: 'reply-prism',
  surface,
  component: 'AssistantMessage' as const,
  props: { text, isFirstOfReply: true },
  requestId,
  viewport: { columns: 160, rows: 60 },
})

/** セッションを始め、作業ディレクトリとホームを覚えさせる。 */
const start = async ($: Dollar, on: On) => {
  mock.env(on, { HOME })
  // 「開く:」の行は実在するファイルだけを出す。テストのパスは仮のものなので、/missing/ を含むもの以外は「ある」と答える。
  on('fs.exists', (_, e) => ({ value: !e.path.includes('/missing/') }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', () => ({ cwd: CWD }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

const captureCopies = (on: On): string[] => {
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  return copied
}

// ---------------------------------------------------------------------------
describe('1. ファイルパスをエディタで開く', () => {
  test('行番号を読み分ける', async () => {
    expect(splitTarget('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12, col: 5 })
    expect(splitTarget('src/a.ts:12-20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitTarget('src/a.ts#L7-L9')).toEqual({ path: 'src/a.ts', line: 7 })
    expect(splitTarget('/etc/hosts')).toEqual({ path: '/etc/hosts' })
  })

  test('パスらしいインラインコードだけを拾う', async () => {
    for (const yes of ['src/main/java/com/example/app/Foo.java:12', './a.ts', '~/.zshrc', '/tmp/x.log', 'Makefile/../b.md']) expect(isPathLike(yes)).toBe(true)
    for (const no of ['and/or', '2026/10/05', 'TCP/IP', 'git status', 'foo.ts', '/api/v1/users', 'src/main']) expect(isPathLike(no)).toBe(false)
  })

  test('相対パスは作業ディレクトリ、~ はホームから絶対にする', async () => {
    expect(resolvePath('src/a.ts', CWD, HOME)).toBe('/work/example-app/src/a.ts')
    expect(resolvePath('../lib/b.ts', CWD, HOME)).toBe('/work/lib/b.ts')
    expect(resolvePath('~/.zshrc', CWD, HOME)).toBe('/home/me/.zshrc')
    expect(resolvePath('src/a.ts', '', HOME)).toBeUndefined()
  })

  test('エディタごとの URL。空白や日本語はエスケープする', async () => {
    expect(editorUrl('vscode', '', '/w/a b/設計.md', 3, 2)).toBe('vscode://file/w/a%20b/%E8%A8%AD%E8%A8%88.md:3:2')
    expect(editorUrl('cursor', '', '/w/a.ts', 3)).toBe('cursor://file/w/a.ts:3')
    expect(editorUrl('idea', '', '/w/a.ts', 3)).toBe('idea://open?file=%2Fw%2Fa.ts&line=3')
    expect(editorUrl('file', '', '/w/a.ts', 3)).toBe('file:///w/a.ts')
    expect(editorUrl('off', '', '/w/a.ts', 3)).toBeUndefined()
    expect(editorUrl('off', 'myeditor://open?f={path}&l={line}', '/w/a.ts')).toBe('myeditor://open?f=/w/a.ts&l=1')
  })

  test('文中の相対パス（行番号つき）とインラインコードのパスがリンクになる', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('原因は src/main/java/com/example/app/AppService.java:42 と `hooks/render.tsx:120`、~/.zshrc。and/or は違う。'))
    const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(hrefs).toEqual([
      'vscode://file/work/example-app/src/main/java/com/example/app/AppService.java:42',
      'vscode://file/work/example-app/hooks/render.tsx:120',
      'vscode://file/home/me/.zshrc',
    ])
    expect((await ui.find({ type: 'Text', text: /^src\/main\/java\/com\/example\/app\/AppService\.java:42$/ }))?.props.color).toBeDefined()
    await ui.unmount()
  })

  test('表のセルのパスもリンクになる', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('| ファイル | 行 |\n|---|---|\n| src/app/Foo.java | 3 |'))
    expect((await ui.findAll({ type: 'Link' })).map(l => l.props.href)).toEqual(['vscode://file/work/example-app/src/app/Foo.java'])
    await ui.unmount()
  })

  test('デスクトップではリンクにしない（https 以外を描かないため）', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3', 'desktop'))
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
    await ui.unmount()
  })

  test('editor を off にするとリンクにしない', { options: { editor: 'off' } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
    expect((await ui.find({ type: 'Text', text: /^\/tmp\/app\.ts:3$/ }))?.props.color).toBeDefined()
    await ui.unmount()
  })

  test('エディタを選べる（idea）', { options: { editor: 'idea' } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('idea://open?file=%2Ftmp%2Fapp.ts&line=3')
    await ui.unmount()
  })

  test('URL のひな形を使える', { options: { editorUrlTemplate: 'subl://open?url=file://{path}&line={line}' } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('見る: src/a.ts:9'))
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('subl://open?url=file:///work/example-app/src/a.ts&line=9')
    await ui.unmount()
  })

})

// ---------------------------------------------------------------------------
const TABLE = ['| 名前 | 件数 | 備考 |', '| :--- | ---: | :--- |', '| **alpha** | 10 | a\\|b |', '| ベータ | 9 | `x` |', '| gamma | 100 | [doc](https://example.com/d) |'].join('\n')

describe('2. 表のコピー形式', () => {
  test('Markdown・TSV・Slack の形', async () => {
    const header = ['名前', 'n']
    const rows = [['寿司', '1'], ['ramen "大"', '20']]
    expect(toMarkdown(header, ['left', 'right'], rows)).toBe('| 名前 | n |\n| --- | ---: |\n| 寿司 | 1 |\n| ramen "大" | 20 |')
    expect(toTsv(header, rows)).toBe('名前\tn\n寿司\t1\n"ramen ""大"""\t20')
    expect(toSlack(header, ['left', 'right'], rows)).toBe(['```', '名前         n', '----------  --', '寿司         1', 'ramen "大"  20', '```'].join('\n'))
  })

  test('表の上に 3 つのコピーボタンが並び、それぞれの形でコピーする', async ($, on) => {
    const copied = captureCopies(on)
    const ui = await $.ui.mount(reply(TABLE))
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')
    expect(buttons.map(b => b.props.label)).toEqual(['⧉ Markdown', '⧉ TSV', '⧉ Slack'])
    for (const b of buttons) await ui.press({ key: b.key! })
    expect(copied[0]).toBe(TABLE)
    expect(copied[1]).toBe('名前\t件数\t備考\nalpha\t10\ta|b\nベータ\t9\tx\ngamma\t100\tdoc (https://example.com/d)')
    expect(copied[2]?.startsWith('```\n名前    件数  備考')).toBe(true)
    expect(copied[2]?.split('\n')[4]).toBe('ベータ     9  x')
    await ui.unmount()
  })

  test('形式を絞れる', { options: { tableCopyFormats: 'tsv' } }, async $ => {
    const ui = await $.ui.mount(reply(TABLE))
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary').map(b => b.props.label)).toEqual(['⧉ TSV'])
    await ui.unmount()
  })

  test('並べ替えた表は、その順でコピーする', async ($, on) => {
    const copied = captureCopies(on)
    const ui = await $.ui.mount(reply(TABLE))
    await ui.press({ key: 'sort.b0.1' })
    await ui.press({ key: 'copy0.markdown' })
    await ui.press({ key: 'copy0.tsv' })
    expect(copied[0]).toBe(['| 名前 | 件数 | 備考 |', '| --- | ---: | --- |', '| ベータ | 9 | `x` |', '| **alpha** | 10 | a\\|b |', '| gamma | 100 | [doc](https://example.com/d) |'].join('\n'))
    expect(copied[1]?.split('\n').map(l => l.split('\t')[0])).toEqual(['名前', 'ベータ', 'alpha', 'gamma'])
    await ui.unmount()
  })
})

// ---------------------------------------------------------------------------
const dangerTexts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string; props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor === RED).map(t => t.text)

describe('3. 危ない語を目立たせる', () => {
  const m = buildDanger(['本番', 'prod', 'DELETE', 'rm -rf', '--force'])

  test('語の境目と大文字小文字', async () => {
    const hit = (s: string, mode: 'prose' | 'code' = 'prose') => dangerRanges(s, m, mode).map(r => s.slice(r.start, r.end))
    expect(hit('本番環境の prod-db に DELETE')).toEqual(['本番', 'prod', 'DELETE'])
    expect(hit('product と production')).toEqual([])
    expect(hit('delete the file')).toEqual([])
    expect(hit('delete from t', 'code')).toEqual(['delete'])
    expect(hit('rm  -rf /tmp && git push --force-with-lease')).toEqual(['rm  -rf', '--force'])
    expect(parseWords('a, rm -rf、b\nc')).toEqual(['a', 'rm -rf', 'b', 'c'])
  })

  test('文・表・コードで赤背景になる', async $ => {
    const text = [
      '本番の users に DELETE を流す前に確認する。update the README は対象外。',
      '',
      '| 環境 | 操作 |',
      '|---|---|',
      '| production | TRUNCATE |',
      '',
      '```sql',
      'delete from users where id = 1;',
      '```',
      '',
      '```bash',
      'rm -rf /tmp/build && git push --force',
      '```',
    ].join('\n')
    const ui = await $.ui.mount(reply(text))
    const found = await dangerTexts(ui)
    expect(found).toEqual(['本番', 'DELETE', 'production', 'TRUNCATE', 'delete', 'rm', ' ', '-rf', '--force'])
    expect((await ui.find({ type: 'Text', text: /^DELETE$/ }))?.props.bold).toBe(true)
    await ui.unmount()
  })

  test('ツール行のコマンドでも目立たせる', async $ => {
    const ui = await $.ui.mount({
      plugin: 'reply-prism',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 't2', tool: 'Bash', input: { command: 'psql -h prod-db -c "DELETE FROM jobs"' }, isRunning: false, isErrored: false, isInterrupted: false },
      viewport: { columns: 120, rows: 40 },
    })
    expect(await dangerTexts(ui)).toEqual(['prod', 'DELETE'])
    await ui.unmount()
  })

  test('パスの中の語も目立たせる（リンクのまま）', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('ログは /srv/prod/app.log にある'))
    expect(await dangerTexts(ui)).toEqual(['prod'])
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('vscode://file/srv/prod/app.log')
    await ui.unmount()
  })

  test('語の一覧を置き換え・追加できる', { options: { dangerWords: 'stg-db', dangerWordsExtra: '商用' } }, async $ => {
    const ui = await $.ui.mount(reply('商用の stg-db で DELETE する'))
    expect(await dangerTexts(ui)).toEqual(['商用', 'stg-db'])
    await ui.unmount()
  })

  test('色を変えられる', { options: { dangerBackgroundColor: '#0000ff', dangerColor: 'yellow' } }, async $ => {
    const ui = await $.ui.mount(reply('本番'))
    const t = (await ui.findAll({ type: 'Text', text: /^本番$/ })).find(x => x.props.backgroundColor !== undefined)
    expect(t?.props.backgroundColor).toBe('#0000ff')
    expect(t?.props.color).toBe('yellow')
    await ui.unmount()
  })

  test('mono テーマでは反転で目立たせる', { options: { theme: 'mono' } }, async $ => {
    const ui = await $.ui.mount(reply('本番'))
    expect((await ui.findAll({ type: 'Text', text: /^本番$/ })).some(x => x.props.inverse === true && x.props.bold === true)).toBe(true)
    await ui.unmount()
  })

  test('オフにできる', { options: { dangerHighlight: false } }, async $ => {
    const ui = await $.ui.mount(reply('本番で DELETE'))
    expect(await dangerTexts(ui)).toEqual([])
    await ui.unmount()
  })
})

// ---------------------------------------------------------------------------
/** 画面のどこかに `==` が残っているか（Text の中身はつないだ文字）。 */
const hasMarkSymbol = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).some(t => (t.text ?? '').includes('=='))

/** 送られたプロンプトに付いた注記を集める。 */
const captureContext = (on: On) => {
  const seen: (readonly string[])[] = []
  mock.env(on, {})
  on('prompt.submit', (_, e) => {
    seen.push(e.context ?? [])
    return { text: e.text, context: e.context }
  })
  return seen
}

describe('3b. Claude が ==…== で囲んだ注意箇所', () => {
  test('印の見つけ方: コードの中・対でない・空・空白・改行・=== は印にしない', async () => {
    const found = (line: string) => findMarks(line).map(r => line.slice(r.start, r.end))
    expect(found('この操作は ==元に戻せない== ので ==全件== が消える')).toEqual(['==元に戻せない==', '==全件=='])
    expect(found('`a == b` と `x==y` は比較')).toEqual([])
    expect(found('`a == b` の後の ==本番== は印')).toEqual(['==本番=='])
    expect(found('==`rm -rf` で消える==')).toEqual(['==`rm -rf` で消える=='])
    expect(found('a ==b だけ')).toEqual([])
    expect(found('空の ==== と == == と a == b == c')).toEqual([])
    expect(found('x==y==z と a === b === c')).toEqual([])
    expect(markLines('==前の行\n次の行==')).toBe('==前の行\n次の行==')
    expect(stripMarks('- ==本番== の DELETE\n- `a == b`')).toBe('- 本番 の DELETE\n- `a == b`')
    expect(stripTable('| ==a | b== | ==c== |')).toBe('| ==a | b== | c |')
  })

  test('注記が付く（ユーザーには見えない context）', async ($, on) => {
    const seen = captureContext(on)
    await $.prompt.submit({ text: 'DB を移行して', wait: false, origin: { kind: 'composer' } })
    expect(seen[0]).toContain(DANGER_HINT)
    expect(DANGER_HINT).toContain('==text==')
    expect(DANGER_HINT.split(/\s+/).length < 80).toBe(true)
  })

  test('図の注記をオフにしても、注意箇所の注記は付く', { options: { diagramHints: false } }, async ($, on) => {
    const seen = captureContext(on)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    expect(seen[0]).toEqual([DANGER_HINT])
  })

  test('dangerHints: false なら注記を付けない', { options: { dangerHints: false } }, async ($, on) => {
    const seen = captureContext(on)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    expect(seen[0]).not.toContain(DANGER_HINT)
  })

  test('dangerHighlight: false なら注記も付けない', { options: { dangerHighlight: false } }, async ($, on) => {
    const seen = captureContext(on)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    expect(seen[0]).not.toContain(DANGER_HINT)
  })

  test('囲まれた部分を危ない語と同じ見た目で描き、== は描かない', async $ => {
    const ui = await $.ui.mount(reply('このマイグレーションは ==元に戻せない== ので、先にバックアップを取る。'))
    expect(await dangerTexts(ui)).toEqual(['元に戻せない'])
    const mark = await ui.find({ type: 'Text', text: /^元に戻せない$/ })
    expect(mark?.props.backgroundColor).toBe(RED)
    expect(mark?.props.color).toBe('#ffffff')
    expect(mark?.props.bold).toBe(true)
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('リスト・見出し・引用・表のセルでも描く', async $ => {
    const text = ['## ==全件更新== の前に', '', '- 対象は ==全ユーザー==', '', '> ==戻せない== 操作', '', '| 手順 | 影響 |', '|---|---|', '| 移行 | ==停止する== |'].join('\n')
    const ui = await $.ui.mount(reply(text))
    expect(await dangerTexts(ui)).toEqual(['全件更新', '全ユーザー', '戻せない', '停止する'])
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('コードブロック・インラインコードの中の == はそのまま', async $ => {
    const ui = await $.ui.mount(reply(['`a == b` を確かめる', '', '```ts', 'if (a == b) run()', '```'].join('\n')))
    expect(await ui.find({ type: 'Text', text: /^a == b$/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text' })).some(t => (t.text ?? '').includes('(a == b)'))).toBe(true)
    expect(await dangerTexts(ui)).toEqual([])
    await ui.unmount()
  })

  test('対になっていない == や空の ==== は書かれたとおりの文字', async $ => {
    const ui = await $.ui.mount(reply('x ==y と ==== と == == はそのまま'))
    expect(await ui.find({ type: 'Text', text: /^x ==y と ==== と == == はそのまま$/ })).toBeDefined()
    expect(await dangerTexts(ui)).toEqual([])
    await ui.unmount()
  })

  test('改行をまたぐものは印にしない', async $ => {
    const ui = await $.ui.mount(reply('最初の ==行\n次の行== まで'))
    expect(await ui.find({ type: 'Text', text: /^最初の ==行 次の行== まで$/ })).toBeDefined()
    expect(await dangerTexts(ui)).toEqual([])
    await ui.unmount()
  })

  test('中の太字・パス・危ない語は崩れない（パスはリンクのまま「開く:」にも出る）', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('==**src/db/Migrate.java:12** が本番の users を消す== ので止める'))
    const outer = (await ui.findAll({ type: 'Text' })).find(t => t.props.backgroundColor === RED && /Migrate/.test(t.text ?? ''))
    // テストの描画では Link の中身の前に href が並ぶので、終わりで見る。
    expect(outer?.text?.endsWith('src/db/Migrate.java:12 が本番の users を消す')).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^src\/db\/Migrate\.java:12$/ }))?.props.color).toBe('#ffffff')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('vscode://file/work/example-app/src/db/Migrate.java:12')
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:')).map(b => b.props.label)).toEqual(['Migrate.java:12'])
    expect((await ui.findAll({ type: 'Text', text: /^本番$/ })).some(t => t.props.backgroundColor === RED)).toBe(true)
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('dangerHighlight: false なら印を外した普通の文字で描く', { options: { dangerHighlight: false } }, async $ => {
    const ui = await $.ui.mount(reply('この操作は ==元に戻せない== ので注意'))
    expect(await dangerTexts(ui)).toEqual([])
    expect(await ui.find({ type: 'Text', text: /^この操作は 元に戻せない ので注意$/ })).toBeDefined()
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('mono テーマでは反転で描く', { options: { theme: 'mono' } }, async $ => {
    const ui = await $.ui.mount(reply('==戻せない=='))
    expect((await ui.findAll({ type: 'Text', text: /^戻せない$/ })).some(x => x.props.inverse === true && x.props.bold === true)).toBe(true)
    await ui.unmount()
  })

  test('デスクトップでも == は描かない', async $ => {
    const ui = await $.ui.mount(reply('- ==全件== を消す\n\n| a |\n|---|\n| ==停止== |', 'desktop'))
    expect(await dangerTexts(ui)).toEqual(['全件', '停止'])
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('リスト・引用・表のコピーからは印を外す（危ない語とコードはそのまま）', async ($, on) => {
    const copied = captureCopies(on)
    const text = ['- ==本番== の DELETE', '- `a == b`', '', '> ==戻せない== 操作', '', '| 手順 | 影響 |', '|---|---|', '| 移行 | ==停止する== |', '', '```sql', 'select 1 where a == b', '```'].join('\n')
    const ui = await $.ui.mount(reply(text))
    for (const key of ['copy0', 'copy1', 'copy2.markdown', 'copy2.tsv', 'copy2.slack', 'copy3']) await ui.press({ key })
    expect(copied[0]).toBe('- 本番 の DELETE\n- `a == b`')
    expect(copied[1]).toBe('戻せない 操作')
    expect(copied[2]).toBe('| 手順 | 影響 |\n|---|---|\n| 移行 | 停止する |')
    expect(copied[3]).toBe('手順\t影響\n移行\t停止する')
    expect(copied[4]?.includes('停止する')).toBe(true)
    expect(copied[4]?.includes('==')).toBe(false)
    expect(copied[5]).toBe('select 1 where a == b')
    await ui.unmount()
  })

  test('印のある表も並べ替えられ、並べ替えたコピーにも印は残らない', async ($, on) => {
    const copied = captureCopies(on)
    const ui = await $.ui.mount(reply('| 環境 | 件数 |\n|---|---:|\n| prod | ==100== |\n| dev | 9 |'))
    await ui.press({ key: 'sort.b0.1' })
    await ui.press({ key: 'copy0.markdown' })
    expect(copied[0]).toBe('| 環境 | 件数 |\n| --- | ---: |\n| dev | 9 |\n| prod | 100 |')
    await ui.unmount()
  })

  test('右から左に描くときも印を描かない', { options: { rtl: 'warp' } }, async $ => {
    const ui = await $.ui.mount(reply('שלום ==עולם== סוף'))
    expect((await dangerTexts(ui)).length > 0).toBe(true)
    expect(await hasMarkSymbol(ui)).toBe(false)
    await ui.unmount()
  })

  test('/reply-prism demo に見本がある', async () => {
    expect(findMarks(showcaseText(['nord']).split('\n').find(l => l.includes('==')) ?? '')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
const longCode = (n: number) => ['```ts', ...Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1}`), '```'].join('\n')
const longTable = (n: number) => ['| id | v |', '|---|---|', ...Array.from({ length: n }, (_, i) => `| row${i + 1} | ${i + 1} |`)].join('\n')

describe('4. 長い表・コードを畳む', () => {
  test('長いコードは先頭だけ見せ、ボタンで開閉する。コピーは全行', async ($, on) => {
    const copied = captureCopies(on)
    const ui = await $.ui.mount(reply(longCode(50)))
    expect(await ui.find({ type: 'Text', text: /^const line15 = 15$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^const line16 = 16$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'fold0' }))?.props.label).toBe('あと 35 行を表示')
    expect(await ui.find({ type: 'Text', text: /50 行/ })).toBeDefined()

    await ui.press({ key: 'fold0' })
    expect(await ui.find({ type: 'Text', text: /^const line50 = 50$/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.label === '畳む').map(b => b.key)).toEqual(['foldtop0', 'fold0'])

    await ui.press({ key: 'foldtop0' })
    expect(await ui.find({ type: 'Text', text: /^const line50 = 50$/ })).toBeUndefined()

    await ui.press({ key: 'copy0' })
    expect(copied[0]?.split('\n')).toHaveLength(50)
    await ui.unmount()
  })

  test('閾値以下は畳まない', async $ => {
    const ui = await $.ui.mount(reply(longCode(40)))
    expect(await ui.find({ type: 'Button', key: 'fold0' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^const line40 = 40$/ })).toBeDefined()
    await ui.unmount()
  })

  test('長い表も畳む', async $ => {
    const ui = await $.ui.mount(reply(longTable(120)))
    expect(await ui.find({ type: 'Text', text: /^row15$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^row16$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'fold.b0' }))?.props.label).toBe('あと 105 行を表示')
    await ui.press({ key: 'fold.b0' })
    expect(await ui.find({ type: 'Text', text: /^row120$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'foldtop0' })).toBeDefined()
    await ui.unmount()
  })

  test('開いた状態はメッセージごと', async $ => {
    const a = await $.ui.mount(reply(longCode(50), 'terminal', 'msg-a'))
    await a.press({ key: 'fold0' })
    const b = await $.ui.mount(reply(longCode(50), 'terminal', 'msg-b'))
    expect(await b.find({ type: 'Text', text: /^const line50 = 50$/ })).toBeUndefined()
    await a.unmount()
    await b.unmount()
  })

  test('行数を設定できる。0 で畳まない', { options: { foldLines: 10, foldPreviewLines: 3 } }, async $ => {
    const ui = await $.ui.mount(reply(longCode(12)))
    expect((await ui.find({ type: 'Button', key: 'fold0' }))?.props.label).toBe('あと 9 行を表示')
    await ui.unmount()
  })

  test('0 で畳まない', { options: { foldLines: 0 } }, async $ => {
    const ui = await $.ui.mount(reply(longCode(200)))
    expect(await ui.find({ type: 'Button', key: 'fold0' })).toBeUndefined()
    await ui.unmount()
  })
})

// ---------------------------------------------------------------------------
describe('5. 表を列で並べ替える', () => {
  test('値の種類を見分けて比べる', async () => {
    expect(columnKind(['1,234', '-5.2', '12%', ''])).toBe('number')
    expect(columnKind(['v1.2.10', '1.10.0', '2.1.289'])).toBe('version')
    expect(columnKind(['2026-10-05 12:00', '2026/09/30', '2026年1月2日'])).toBe('date')
    expect(columnKind(['abc', '12'])).toBe('text')
    expect(parseNumber('3.5GB')! > parseNumber('900MB')!).toBe(true)
    expect(parseNumber('1m 20s')).toBe(80_000)
    expect(parseNumber('250ms')! < parseNumber('2s')!).toBe(true)
    expect(parseDate('2026-10-05T00:00:00+09:00')).toBe(Date.UTC(2026, 9, 4, 15))
  })

  test('数・バージョン・日時・文字の並び。空の値はいつも最後', async () => {
    const order = (values: string[], dir: 'asc' | 'desc' = 'asc') => sortOrder(values.map(v => [v]), 0, dir).map(i => values[i])
    expect(order(['10', '9', '-', '100', '1,000'])).toEqual(['9', '10', '100', '1,000', '-'])
    expect(order(['約1,121', '約225', '約628', '~343'])).toEqual(['約225', '~343', '約628', '約1,121'])
    expect(order(['10', '9', '-', '100'], 'desc')).toEqual(['100', '10', '9', '-'])
    expect(order(['v1.10.0', 'v1.2.0', 'v1.9.3'])).toEqual(['v1.2.0', 'v1.9.3', 'v1.10.0'])
    expect(order(['1.0.0', '1.0.0-rc.1'])).toEqual(['1.0.0-rc.1', '1.0.0'])
    expect(order(['2026/10/05 9:00', '2026-10-05 08:59', '2025-12-31'])).toEqual(['2025-12-31', '2026-10-05 08:59', '2026/10/05 9:00'])
    expect(order(['item10', 'item2', 'Item1'])).toEqual(['Item1', 'item2', 'item10'])
    expect(order(['b', 'a', 'b', 'a'])).toEqual(['a', 'a', 'b', 'b'])
  })

  test('昇順 → 降順 → 元の順', async () => {
    expect(nextSort({}, 1)).toEqual({ col: 1, dir: 'asc' })
    expect(nextSort({ col: 1, dir: 'asc' }, 1)).toEqual({ col: 1, dir: 'desc' })
    expect(nextSort({ col: 1, dir: 'desc' }, 1)).toEqual({})
    expect(nextSort({ col: 1, dir: 'desc' }, 0)).toEqual({ col: 0, dir: 'asc' })
  })

  test('見出しのボタンで並べ替える', async $ => {
    const ui = await $.ui.mount(reply(TABLE))
    const names = async () => {
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      return ['alpha', 'ベータ', 'gamma'].sort((a, b) => texts.indexOf(a) - texts.indexOf(b))
    }
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('sort.')).map(b => b.props.label)).toEqual(['⇅', '⇅', '⇅'])
    await ui.press({ key: 'sort.b0.1' })
    expect(await names()).toEqual(['ベータ', 'alpha', 'gamma'])
    expect((await ui.find({ type: 'Button', key: 'sort.b0.1' }))?.props.label).toBe('▲')
    await ui.press({ key: 'sort.b0.1' })
    expect(await names()).toEqual(['gamma', 'alpha', 'ベータ'])
    expect((await ui.find({ type: 'Button', key: 'sort.b0.1' }))?.props.label).toBe('▼')
    await ui.press({ key: 'sort.b0.1' })
    expect(await names()).toEqual(['alpha', 'ベータ', 'gamma'])
    await ui.unmount()
  })

  test('並べ替えてから畳むので、降順の上位が見える', async $ => {
    const ui = await $.ui.mount(reply(longTable(60)))
    await ui.press({ key: 'sort.b0.1' })
    await ui.press({ key: 'sort.b0.1' })
    expect(await ui.find({ type: 'Text', text: /^row60$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^row1$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('1 行だけの表とオフのときはボタンを置かない', { options: { tableSort: false } }, async $ => {
    const ui = await $.ui.mount(reply(TABLE))
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('sort.'))).toHaveLength(0)
    await ui.unmount()
  })

  test('表の元の書き方を覚えている', async () => {
    const [t] = parse(TABLE, { numbers: true, paths: true })
    if (t?.kind !== 'table') throw new Error('not a table')
    expect(t.source.rows[0]).toEqual(['**alpha**', '10', 'a|b'])
  })
})

describe('6. 日本語の Mermaid', () => {
  const box = (art: string) => art.split('\n').filter(line => /[┌│└]/.test(line[0] ?? ''))

  test('全角のラベルでも箱の各行が同じ幅にそろい、ラベルはそのまま出る', () => {
    const art = mermaidText('flowchart LR\n  S[送信] --> T[ターン]\n  T --> C[候補を作る]', false, 120) ?? ''
    const lines = box(art)

    expect(lines.length).toBeGreaterThan(2)
    expect(new Set(lines.map(width)).size).toBe(1)
    expect(art).toContain('候補を作る')
    expect(art).not.toMatch(/[-]/)
  })

  test('英語だけの図は本家と同じ', () => {
    const art = mermaidText('flowchart LR\n  A[Send] --> B[Turn]', false, 120) ?? ''

    expect(art).toContain('│ Send ├──►│ Turn │')
  })
})

describe('7. 棒グラフの縦軸の目盛り', () => {
  const ticksOf = (art: string) => art.split('\n').flatMap((line, row) => (/^\s*-?\d+(\.\d+)?[┤┼]/.test(line) ? [{ row, value: Number(line.trim().split(/[┤┼]/)[0]) }] : []))

  test('目盛りが重ならず全部出て、等間隔に並ぶ', () => {
    for (const range of ['0 --> 160', '0 --> 100', '0 --> 8']) {
      const art = mermaidText(`xychart-beta\n  x-axis [a, b, c, d, e]\n  y-axis "n" ${range}\n  bar [49, 43, 147, 9, 12]`, false, 120) ?? ''
      const ticks = ticksOf(art)
      const gaps = new Set(ticks.slice(1).map((t, i) => t.row - ticks[i]!.row))

      expect(ticks.length, range).toBeGreaterThan(3)
      expect(gaps.size, `${range}: 間隔がそろう`).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 全画面表示の端末（Orca など）ではリンクのクリックが Mod に届かず開かないので、押して開くボタンを置く。
describe('8. 押してエディタで開くボタン', () => {
  const toolUse = (tool: string, input: unknown, surface: 'terminal' | 'desktop' = 'terminal') => ({
    plugin: 'reply-prism',
    surface,
    component: 'ToolUse' as const,
    props: { tool_use_id: 't1', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
    requestId: 't1',
    viewport: { columns: 120, rows: 40 },
  })

  /** `open` / `xdg-open` に渡された argv を集める。`missing` に挙げたコマンドは無いものとして投げる。 */
  const captureRuns = (on: On, missing: readonly string[] = []) => {
    const runs: string[][] = []
    on('process.run', (_, e) => {
      runs.push([...e.argv])
      if (missing.includes(e.argv[0]!)) throw new Error(`${e.argv[0]}: not found`)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    return runs
  }

  const captureToasts = (on: On) => {
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    return toasts
  }

  const opens = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: string; props: { label?: unknown } }[]> }) =>
    (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:'))

  test('実在しないファイル（作業ディレクトリの外のファイルを相対パスで書いたなど）は「開く:」に出さない', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('`src/app.ts` と `missing/gone.ts` を見た'))
    const labels = (await ui.findAll({ tag: 'Button' })).map(b => String(b.props['label'] ?? ''))
    expect(labels.some(l => l.includes('app.ts'))).toBe(true)
    expect(labels.some(l => l.includes('gone.ts'))).toBe(false)
    await ui.unmount()
  })

  test('key は行・桁・絶対パスを持ち、key だけから戻せる', () => {
    expect(openKey({ abs: '/w/a.ts', line: 12, col: 5 })).toBe('open:12:5:/w/a.ts')
    expect(parseOpenKey('open:12:5:/w/a.ts')).toEqual({ abs: '/w/a.ts', line: 12, col: 5 })
    expect(parseOpenKey('open:0:0:C:/w/a b.ts')).toEqual({ abs: 'C:/w/a b.ts' })
    expect(parseOpenKey('copy0')).toBeUndefined()
    expect(openLabel({ abs: '/w/src/Foo.java', line: 12 })).toBe('Foo.java:12')
    expect(openLabel({ abs: '/w/.zshrc' })).toBe('.zshrc')
  })

  test('返事の http(s) のリンクも「開く:」の行のボタンになり、押すとブラウザで開く。ボタンと本文のリンクに同じ番号を付ける', async ($, on) => {
    const runs = captureRuns(on)
    await start($, on)
    const text = [
      '| 版 | ファイル |',
      '|---|---|',
      '| 1.10 | [仕様書](https://example.com/files/a/view) |',
      '| 1.09 | [仕様書](https://example.com/files/b/view) |',
      '',
      '詳しくは https://example.com/docs/guide を見て。[同じもの](https://example.com/files/a/view) と ftp://example.com/x も。',
    ].join('\n')
    const ui = await $.ui.mount(reply(text))
    const urls = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('url:'))
    expect(urls.map(b => [b.key, b.props.label])).toEqual([
      ['url:https://example.com/files/a/view', '[1] 仕様書'],
      ['url:https://example.com/files/b/view', '[2] 仕様書'],
      ['url:https://example.com/docs/guide', '[3] example.com/.../guide'],
    ])
    // 本文のリンクの後ろにも同じ番号（同じ URL は同じ番号）
    expect((await ui.findAll({ type: 'Text', text: /^ \[1\]$/ })).length, '表の 1 行目と文中の「同じもの」').toBe(2)
    expect(await ui.findAll({ type: 'Text', text: /^ \[2\]$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^ \[3\]$/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /^開く:$/ })).toBeDefined()
    // 文中の URL の文字はそのまま残す
    expect(await ui.find({ type: 'Text', text: / \(https:\/\/example\.com\/files\/a\/view\)/ })).toBeDefined()
    await ui.press({ key: 'url:https://example.com/files/b/view' })
    expect(runs).toEqual([['open', 'https://example.com/files/b/view']])
    await ui.unmount()
  })

  test('上限を超えて「開く:」に出せなかった URL には番号を付けない', { options: { openRowMax: 2 } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('[a](https://example.com/a) [b](https://example.com/b) [c](https://example.com/c)'))
    const urls = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('url:'))
    expect(urls.map(b => b.props.label)).toEqual(['[1] a', '[2] b'])
    expect(await ui.find({ type: 'Text', text: /^ほか 1 件$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^ \[3\]$/ })).toHaveLength(0)
    await ui.unmount()
  })

  test('URL のボタンの key は http(s) だけを戻す', () => {
    expect(parseUrlKey(urlKey('https://example.com/a?b=1#c'))).toBe('https://example.com/a?b=1#c')
    expect(parseUrlKey('url:file:///etc/passwd')).toBeUndefined()
    expect(parseUrlKey('url:javascript:alert(1)')).toBeUndefined()
    expect(parseUrlKey('open:0:0:/w/a.ts')).toBeUndefined()
    expect(urlLabel('https://example.com')).toBe('example.com')
    expect(urlLabel('https://example.com/a')).toBe('example.com/a')
  })

  test('Read・Edit のツール行のパスは押すと開くボタンになる（リンクにはしない）', async ($, on) => {
    const runs = captureRuns(on)
    await start($, on)
    const ui = await $.ui.mount(toolUse('Read', { file_path: '/work/example-app/bin/run' }))
    const [button] = await opens(ui)
    expect(button?.key).toBe('open:0:0:/work/example-app/bin/run')
    expect(button?.props.label).toBe('/work/example-app/bin/run')
    expect((await ui.find({ type: 'Button', key: button!.key! }))?.props.plain).toBe(true)
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
    await ui.press({ key: button!.key! })
    expect(runs).toEqual([['open', 'vscode://file/work/example-app/bin/run']])
    await ui.unmount()

    const edit = await $.ui.mount(toolUse('Edit', { file_path: '~/.zshrc' }))
    expect((await opens(edit)).map(b => [b.key, b.props.label])).toEqual([['open:0:0:/home/me/.zshrc', '~/.zshrc']])
    await edit.unmount()
  })

  test('ファイル以外のツール行・デスクトップ・editor: off ではボタンにしない', async ($, on) => {
    await start($, on)
    const grep = await $.ui.mount(toolUse('Grep', { pattern: 'TODO', path: '/work/example-app/src' }))
    expect(await opens(grep)).toHaveLength(0)
    await grep.unmount()
    const desktop = await $.ui.mount(toolUse('Read', { file_path: '/tmp/app.ts' }, 'desktop'))
    expect(await opens(desktop)).toHaveLength(0)
    expect((await desktop.find({ type: 'Text', text: /^\/tmp\/app\.ts$/ }))).toBeDefined()
    await desktop.unmount()
  })

  test('editor: off ならツール行も返事もボタンにしない', { options: { editor: 'off' } }, async ($, on) => {
    await start($, on)
    const row = await $.ui.mount(toolUse('Read', { file_path: '/tmp/app.ts' }))
    expect(await opens(row)).toHaveLength(0)
    expect((await row.find({ type: 'Text', text: /^\/tmp\/app\.ts$/ }))?.props.color).toBeDefined()
    await row.unmount()
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    expect(await opens(ui)).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^開く:$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('返事の最後に「開く:」とパスのボタンを出てきた順に並べる（文中・表のセル・インラインコード）', async ($, on) => {
    const runs = captureRuns(on)
    await start($, on)
    const text = [
      '原因は src/main/java/com/example/app/AppService.java:42 と `hooks/render.tsx:120`。',
      '',
      '| ファイル | 行 |',
      '|---|---|',
      '| src/app/Foo.java | 3 |',
      '',
      '- ~/.zshrc も見る。and/or や `git status` は違う。',
    ].join('\n')
    const ui = await $.ui.mount(reply(text))
    const buttons = await opens(ui)
    expect(buttons.map(b => b.props.label)).toEqual(['AppService.java:42', 'render.tsx:120', 'Foo.java', '.zshrc'])
    expect(buttons.map(b => b.key)).toEqual([
      'open:42:0:/work/example-app/src/main/java/com/example/app/AppService.java',
      'open:120:0:/work/example-app/hooks/render.tsx',
      'open:0:0:/work/example-app/src/app/Foo.java',
      'open:0:0:/home/me/.zshrc',
    ])
    expect((await ui.find({ type: 'Text', text: /^開く:$/ }))?.props.dimColor).toBe(true)
    // 文中・表のリンクはそのまま残る（cmd+クリックで開ける端末向け）。
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(4)
    await ui.press({ key: 'open:42:0:/work/example-app/src/main/java/com/example/app/AppService.java' })
    expect(runs).toEqual([['open', 'vscode://file/work/example-app/src/main/java/com/example/app/AppService.java:42']])
    await ui.unmount()
  })

  test('同じパス＋行は 1 つにまとめ、行が違えば別にする', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('src/a.ts:12 と `src/a.ts:12` と ./src/a.ts:12、src/a.ts:30、src/a.ts'))
    expect((await opens(ui)).map(b => b.props.label)).toEqual(['a.ts:12', 'a.ts:30', 'a.ts'])
    await ui.unmount()
  })

  test('上限を超えた分は「ほか N 件」', { options: { openRowMax: 2 } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('src/a.ts src/b.ts src/c.ts src/d.ts'))
    expect((await opens(ui)).map(b => b.props.label)).toEqual(['a.ts', 'b.ts'])
    expect((await ui.find({ type: 'Text', text: /^ほか 2 件$/ }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('既定の上限は 8', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply(Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`).join(' ')))
    expect(await opens(ui)).toHaveLength(8)
    expect(await ui.find({ type: 'Text', text: /^ほか 2 件$/ })).toBeDefined()
    await ui.unmount()
  })

  test('openRow: false なら「開く」の行を出さない（ツール行のボタンとリンクは残る）', { options: { openRow: false } }, async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    expect(await opens(ui)).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^開く:$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('vscode://file/tmp/app.ts:3')
    await ui.unmount()
    const row = await $.ui.mount(toolUse('Read', { file_path: '/tmp/app.ts' }))
    expect(await opens(row)).toHaveLength(1)
    await row.unmount()
  })

  test('パスが無い返事・デスクトップでは「開く」の行を出さない', async ($, on) => {
    await start($, on)
    const none = await $.ui.mount(reply('パスは無い。and/or。'))
    expect(await none.find({ type: 'Text', text: /^開く:$/ })).toBeUndefined()
    await none.unmount()
    const desktop = await $.ui.mount(reply('見る: /tmp/app.ts:3', 'desktop'))
    expect(await opens(desktop)).toHaveLength(0)
    await desktop.unmount()
  })

  test('エディタとひな形に従った URL で開く', { options: { editor: 'idea' } }, async ($, on) => {
    const runs = captureRuns(on)
    await start($, on)
    const ui = await $.ui.mount(reply('見る: src/a.ts:9:4'))
    await ui.press({ key: 'open:9:4:/work/example-app/src/a.ts' })
    expect(runs).toEqual([['open', 'idea://open?file=%2Fwork%2Fexample-app%2Fsrc%2Fa.ts&line=9&column=4']])
    await ui.unmount()
  })

  test('open が無ければ xdg-open で開く', async ($, on) => {
    const runs = captureRuns(on, ['open'])
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    await ui.press({ key: 'open:3:0:/tmp/app.ts' })
    expect(runs).toEqual([['open', 'vscode://file/tmp/app.ts:3'], ['xdg-open', 'vscode://file/tmp/app.ts:3']])
    await ui.unmount()
  })

  test('どちらのコマンドも無ければトーストで知らせる', async ($, on) => {
    captureRuns(on, ['open', 'xdg-open'])
    const toasts = captureToasts(on)
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    await ui.press({ key: 'open:3:0:/tmp/app.ts' })
    expect(toasts).toEqual(['ファイルを開くコマンド（open / xdg-open）が見つかりません'])
    await ui.unmount()
  })

  /** `open` / `xdg-open` が 0 以外の終了コードで終わる（コマンドはある）。`codes` に無いコマンドは 0。 */
  const failingRuns = (on: On, codes: Record<string, number>) => {
    const runs: string[][] = []
    on('process.run', (_, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: codes[e.argv[0]!] ?? 0, stdout: '', stderr: `${e.argv[0]} failed`, isStdoutTruncated: false, isStderrTruncated: false } }
    })
    return runs
  }

  test('open が終了コード 0 以外で失敗したら xdg-open も試す', async ($, on) => {
    const runs = failingRuns(on, { open: 1 })
    const toasts = captureToasts(on)
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    await ui.press({ key: 'open:3:0:/tmp/app.ts' })
    expect(runs.map(r => r[0])).toEqual(['open', 'xdg-open'])
    expect(toasts).toEqual([])
    await ui.unmount()
  })

  test('どちらも終了コード 0 以外なら、最後のエラーでトーストする', async ($, on) => {
    const runs = failingRuns(on, { open: 1, 'xdg-open': 3 })
    const toasts = captureToasts(on)
    await start($, on)
    const ui = await $.ui.mount(reply('見る: /tmp/app.ts:3'))
    await ui.press({ key: 'open:3:0:/tmp/app.ts' })
    expect(runs.map(r => r[0])).toEqual(['open', 'xdg-open'])
    expect(toasts).toEqual(['開けませんでした: xdg-open failed'])
    await ui.unmount()
  })

  test('他のボタン（コピー・並べ替え）は今まで通りで、エディタを開かない', async ($, on) => {
    const runs = captureRuns(on)
    const copied = captureCopies(on)
    await start($, on)
    const ui = await $.ui.mount(reply('| ファイル | 件数 |\n|---|---:|\n| src/b.ts | 2 |\n| src/a.ts | 1 |'))
    await ui.press({ key: 'sort.b0.1' })
    await ui.press({ key: 'copy0.tsv' })
    expect(copied).toEqual(['ファイル\t件数\nsrc/a.ts\t1\nsrc/b.ts\t2'])
    expect(runs).toEqual([])
    expect((await opens(ui)).map(b => b.props.label)).toEqual(['b.ts', 'a.ts'])
    await ui.unmount()
  })
})

describe('上限つきの覚え', () => {
  test('開いたツール呼び出しの id は上限を超えたら古いものから忘れる', () => {
    const calls = makeExpandedCalls(3)
    for (const id of ['a', 'b', 'c', 'd']) calls.add(id)
    expect(calls.size).toBe(3)
    expect(calls.has('a')).toBe(false)
    expect(['b', 'c', 'd'].every(id => calls.has(id))).toBe(true)
  })

  test('ファイルの有無の覚えは上限を超えて増えない', async ($, on) => {
    on('fs.exists', () => ({ value: true }))
    const cache: ExistsCache = new Map()
    const paths = Array.from({ length: EXISTS_LIMIT + 50 }, (_, i) => `/p/${i}`)
    const found = await existingFiles($, cache, paths)
    expect(found.size).toBe(paths.length)
    expect(cache.size).toBeLessThanOrEqual(EXISTS_LIMIT)
  })
})
