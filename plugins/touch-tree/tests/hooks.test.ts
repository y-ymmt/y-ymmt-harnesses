/**
 * hooks.tsx を偽の `$` と `on` で動かすテスト。`bun test` で走る（claude-code/testing に依存しない）。
 *
 *   bun test plugins/touch-tree/tests/
 */
import { beforeAll, describe, expect, test } from 'bun:test'

import { FLUSH_MS, MAX_ROWS, OPEN_PREFIX, PANE, register } from '../hooks/hooks'
import { textWidth } from '../hooks/tree'
import type { TouchTreeRecord } from '../types'

/** 偽の描画木の 1 要素。エンジンの `h` と同じく `{ type, props, children }`。 */
type Element = {
  readonly type: string
  readonly props: Record<string, unknown>
  readonly children: readonly Node[]
}
type Node = Element | string

/** JSX は大域の `h` で組まれる（tsconfig の jsxFactory）。エンジンと同じ形の木を返す。 */
beforeAll(() => {
  const flat = (children: readonly unknown[]): Node[] =>
    children.flatMap(child =>
      Array.isArray(child)
        ? flat(child)
        : child === null || child === undefined || child === false || child === true
          ? []
          : [typeof child === 'number' ? String(child) : (child as Node)],
    )

  ;(globalThis as Record<string, unknown>)['h'] = (
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): Element => ({ type, props: props ?? {}, children: flat(children) })
  ;(globalThis as Record<string, unknown>)['Fragment'] = 'Fragment'
})

const ROOT = '/work/example-app'
const HOME = '/Users/me'
const JAVA = `${ROOT}/src/main/java/com/example/app`

type Hook = (...args: never[]) => unknown
type Registered = { readonly event: string; readonly matcher: Record<string, unknown> | null; readonly hook: Hook }

/**
 * Claude Code のプロセス 1 つぶん。register() を走らせ、イベントを順に流せる。
 */
class Process {
  readonly hooks: Registered[] = []
  readonly timers: { at: number; fn: () => void; isCancelled: boolean }[] = []
  readonly state = new Map<string, unknown>()
  readonly store: Map<string, unknown>
  readonly files: Set<string>
  invalidations = 0
  readonly opened: string[] = []
  readonly closed: string[] = []
  readonly commands: string[] = []
  readonly runs: string[][] = []
  readonly toasts: string[] = []
  stateSets: string[] = []
  isRendering = false
  nowMs = 1_000_000
  cwd = ROOT
  readonly $: Record<string, unknown>

  constructor(files: readonly string[] = [], store = new Map<string, unknown>(), private readonly options: Record<string, unknown> = {}) {
    this.files = new Set(files)
    this.store = store

    const keyOf = (ref: { plugin: string; key: string }): string => `${ref.plugin}.${ref.key}`

    this.$ = {
      session: { root: async () => ROOT, cwd: async () => this.cwd },
      env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
      process: {
        run: async (argv: string[]) =>
          argv.join(' ') === 'git rev-parse --show-toplevel'
            ? { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'unknown' },
      },
      fs: {
        stat: async (path: string) => {
          if (this.files.has(path)) return { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
          if ([...this.files].some(f => f.startsWith(path + '/'))) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          throw new Error('ENOENT')
        },
      },
      clock: {
        now: async () => this.nowMs,
        after: (ms: number, fn: () => void) => {
          const timer = { at: this.nowMs + ms, fn, isCancelled: false }
          this.timers.push(timer)
          return { cancel: () => (timer.isCancelled = true) }
        },
      },
      state: {
        get: async (ref: { plugin: string; key: string }) => {
          const key = keyOf(ref)
          return this.state.has(key) ? { value: structuredClone(this.state.get(key)), version: 1 } : { value: undefined, version: 0 }
        },
        set: async (ref: { plugin: string; key: string }, value: unknown) => {
          if (this.isRendering) throw new Error('state.set while drawing')
          if (value === undefined) throw new Error('undefined value')
          this.state.set(keyOf(ref), structuredClone(value))
          this.stateSets.push(keyOf(ref))
          return { isSet: true, version: 2 }
        },
      },
      store: {
        get: async (key: string) => this.store.get(key),
        set: async (key: string, value: unknown) => void this.store.set(key, value),
      },
      command: { register: async ({ name }: { name: string }) => void this.commands.push(name) },
      process: {
        run: async (argv: readonly string[]) => {
          if (argv[0] === 'open' || argv[0] === 'xdg-open') this.runs.push([...argv])
          if (argv[0] === 'git') return { exitCode: 1, stdout: '', stderr: '' }
          if (argv[0] !== 'open') throw new Error('not found')
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      ui: {
        toast: (text: string) => void this.toasts.push(text),
        resolve: () => ({ Box: 'Box', Text: 'Text', Link: 'Link', Button: 'Button', Raster: 'Raster' }),
        open: async ({ id }: { id: string }) => {
          this.opened.push(id)
          return { isPlaced: true }
        },
        close: async ({ id }: { id: string }) => void this.closed.push(id),
        invalidate: () => void (this.invalidations += 1),
      },
    }

    const on = (event: string, matcherOrHook: unknown, maybeHook?: unknown): void => {
      const hook = (maybeHook ?? matcherOrHook) as Hook
      const matcher = maybeHook === undefined ? null : (matcherOrHook as Record<string, unknown>)

      this.hooks.push({ event, matcher, hook })
    }

    ;(register as unknown as (on: unknown, options: unknown) => void)(on, this.options)
  }

  /** イベントを流す。合うフックが無ければ core の値をそのまま返す。 */
  async emit(event: string, e: Record<string, unknown>, core: (e: unknown) => unknown = () => ({})): Promise<unknown> {
    const found = this.hooks.find(
      ({ event: name, matcher }) =>
        name === event && (matcher === null || Object.entries(matcher).every(([key, value]) => e[key] === value)),
    )
    const next = async (passed: unknown): Promise<unknown> => core(passed)

    return found === undefined ? core(e) : (found.hook as unknown as (...args: unknown[]) => unknown)(this.$, e, next)
  }

  async sessionStart(): Promise<void> {
    await this.emit('session.start', { cwd: ROOT, surface: 'terminal', isInteractive: true })
  }

  /** ツールを 1 回呼ぶ。result は core（ツール本体）の答え。 */
  async tool(input: Record<string, unknown>, answer: Record<string, unknown>): Promise<void> {
    await this.emit('tool.call', { tool_use_id: `t${this.nowMs}`, ...input }, () => answer)
  }

  /** 時計を進め、期限の来たタイマーを回す。 */
  async advance(ms: number): Promise<void> {
    this.nowMs += ms

    for (const timer of [...this.timers]) {
      if (!timer.isCancelled && timer.at <= this.nowMs) {
        timer.isCancelled = true
        timer.fn()
      }
    }

    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  record(): TouchTreeRecord {
    return this.state.get('touch-tree.record') as TouchTreeRecord
  }

  async pane(columns: number): Promise<Node> {
    this.isRendering = true

    try {
      return (await this.emit('ui.render', {
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE,
        viewport: { columns: columns * 3, rows: 40 },
        props: { title: 'touch-tree', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { bodyRows: 30 } },
      })) as Node
    } finally {
      this.isRendering = false
    }
  }
}

/** 木の中の文字列をすべてつなげたもの。 */
function textOf(node: Node): string {
  if (typeof node === 'string') return node
  // ファイル名はボタンの label に入っている。
  if (node.type === 'Button') return String(node.props['label'] ?? '')

  return node.children.map(textOf).join('')
}

/** 木を平らにする。 */
function flatten(node: Node): Element[] {
  return typeof node === 'string' ? [] : [node, ...node.children.flatMap(flatten)]
}

/**
 * エンジンの木の検証に寄せた確認。落ちる理由を文字列で返す（通れば空）。
 *
 * - 要素は Box・Text・Button だけ
 * - Text の color は `#RRGGBB` の文字列、子は文字列か Text、1 つの文字列は 1 万文字まで
 * - Box の子は要素（裸の文字列は不可）、Button は子を持たず key・label・onPress がある
 * - bold・dimColor・underline は boolean
 */
function invalidReasonOf(node: Node, parent: string | null = null): string {
  if (typeof node === 'string') {
    if (parent !== 'Text' && parent !== 'Link') return `文字列が ${parent ?? '根'} の直下にある`
    return node.length > 10_000 ? `Text が ${node.length} 文字` : ''
  }

  if (!['Box', 'Text', 'Button', 'Link'].includes(node.type)) return `知らない要素 ${node.type}`
  if (parent === 'Text' && node.type !== 'Text') return `Text の中に ${node.type}`
  if (parent === 'Link' && node.type !== 'Text') return `Link の中に ${node.type}`
  if (node.type === 'Link' && (typeof node.props['href'] !== 'string' || node.props['href'] === '')) return 'Link に href が無い'
  if (parent === 'Button') return 'Button に子がある'

  if (node.type === 'Button') {
    if (node.children.length > 0) return 'Button に子がある'
    if (typeof node.props['key'] !== 'string' || typeof node.props['label'] !== 'string') return 'Button に key か label が無い'
    if (typeof node.props['onPress'] !== 'function') return 'Button に onPress が無い'
  }

  for (const key of ['color', 'backgroundColor']) {
    const value = node.props[key]

    if (value !== undefined && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) {
      return `${key} が文字列の色でない: ${String(value)}`
    }
  }

  for (const key of ['bold', 'dimColor', 'underline']) {
    if (node.props[key] !== undefined && typeof node.props[key] !== 'boolean') return `${key} が boolean でない`
  }

  if (node.type === 'Text') {
    const total = textOf(node).length
    if (total > 10_000) return `Text が ${total} 文字`
  }

  for (const child of node.children) {
    const reason = invalidReasonOf(child, node.type)

    if (reason !== '') return reason
  }

  return ''
}

/** ツリーの各行（キーが row- の Box）の文字。 */
function treeLinesOf(drawn: Node): string[] {
  return flatten(drawn)
    .filter(el => el.type === 'Box' && String(el.props['key'] ?? '').startsWith('row-'))
    .map(textOf)
}

const readResult = (startLine: number, numLines: number, totalLines: number) => ({
  result: { type: 'text', file: { filePath: '', content: '', startLine, numLines, totalLines } },
  text: '',
})

const FILES = [
  `${JAVA}/batch/Imports.java`,
  `${JAVA}/batch/Exports.java`,
  `${JAVA}/web/ApiController.java`,
  `${JAVA}/web/ApiService.java`,
  `${ROOT}/pom.xml`,
  `${HOME}/.claude/CLAUDE.md`,
]

describe('記録と描画', () => {
  test('ファイルの行は押すとエディタで開くボタンになる。フォルダの行と editor: off はボタンにしない', async () => {
    const FILE = `${JAVA}/web/ApiController.java`
    const opensOf = (node: Node) => flatten(node).filter(el => el.type === 'Button' && String(el.props['key']).startsWith(OPEN_PREFIX))
    const boot = async (options: Record<string, unknown>) => {
      const proc = new Process(FILES, new Map(), options)

      await proc.sessionStart()
      await proc.tool({ tool: 'Edit', file_path: FILE }, { result: { filePath: '' }, text: 'ok' })
      await proc.advance(FLUSH_MS)

      return proc
    }
    const pressOpen = (proc: Process, path: string) =>
      proc.emit('ui.press', { plugin: 'touch-tree', element: `${OPEN_PREFIX}${path}`, component: 'Pane', requestId: PANE, surface: 'terminal' })

    const proc = await boot({})
    const drawn = await proc.pane(60)
    const [button] = opensOf(drawn)

    expect(invalidReasonOf(drawn)).toBe('')
    expect(opensOf(drawn).length, 'ファイルの 1 行だけ').toBe(1)
    expect(button?.props['label']).toBe('ApiController.java')
    expect(button?.props['plain']).toBe(true)

    await pressOpen(proc, FILE)
    expect(proc.runs, '既定は VS Code の URL を open で開く').toEqual([['open', `vscode://file${encodeURI(FILE)}`]])

    const idea = await boot({ editor: 'idea' })

    await pressOpen(idea, FILE)
    expect(idea.runs[0]).toEqual(['open', `idea://open?file=${encodeURIComponent(FILE)}`])

    const off = await boot({ editor: 'off' })

    expect(opensOf(await off.pane(60))).toEqual([])
    await pressOpen(off, FILE)
    expect(off.runs).toEqual([])

    const unknown = await boot({ editor: 'emacs' })

    await pressOpen(unknown, FILE)
    expect(unknown.runs[0]?.[1], '知らない値は既定に戻す').toStartWith('vscode://file/')
  })

  test('Read・Edit・Write・Bash の grep を記録し、ツリーで描く', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    expect(proc.commands).toEqual(['touch-tree'])
    expect(proc.opened).toEqual([])

    await proc.tool({ tool: 'Read', file_path: `${JAVA}/batch/Imports.java` }, readResult(1, 120, 120))
    await proc.tool({ tool: 'Read', file_path: `${JAVA}/batch/Exports.java`, offset: 1, limit: 80 }, readResult(1, 80, 400))
    await proc.tool({ tool: 'Read', file_path: `${JAVA}/batch/Exports.java`, offset: 200, limit: 50 }, readResult(200, 50, 400))
    await proc.tool({ tool: 'Edit', file_path: `${JAVA}/web/ApiController.java` }, { result: { filePath: '' }, text: 'ok' })
    await proc.tool({ tool: 'Write', file_path: `${JAVA}/web/NewDto.java` }, { result: { type: 'create', filePath: '' }, text: 'ok' })
    await proc.tool(
      { tool: 'Bash', command: 'grep -rn "callApi" src | head -20' },
      { result: {}, text: `src/main/java/com/example/app/web/ApiService.java:12:  callApi()\nsrc/main/java/com/example/app/web/Gone.java:3:x\n` },
    )
    await proc.tool({ tool: 'Read', file_path: `${HOME}/.claude/CLAUDE.md` }, readResult(1, 10, 10))
    await proc.advance(FLUSH_MS)

    const record = proc.record()

    expect(record.root).toBe(ROOT)
    expect(record.files[`${JAVA}/batch/Exports.java`]?.ranges).toEqual([[1, 80], [200, 249]])
    expect(record.files[`${JAVA}/web/ApiService.java`]?.hits).toBe(1)
    expect(record.files[`${JAVA}/web/Gone.java`], '実在しないパスは拾わない').toBeUndefined()
    expect(record.last).toBe(`${HOME}/.claude/CLAUDE.md`)

    const drawn = await proc.pane(60)

    expect(invalidReasonOf(drawn)).toBe('')
    expect(treeLinesOf(drawn)).toEqual([
      'example-app/ 5 ✎2',
      '└ src/main/java/com/example/app/ 5 ✎2',
      '  ├ batch/ 2',
      '  │ ├ ◐ Exports.java 1-80,200-249/400',
      '  │ └ ● Imports.java 全120行',
      '  └ web/ 3 ✎2',
      '    ├ ✎ ApiController.java ✎1',
      '    ├ ○ ApiService.java 検索',
      '    └ ✚ NewDto.java 新規',
      '(外部) 1',
      '└ ~/.claude/ 1',
      '  └ ● CLAUDE.md 全10行',
    ])
    expect(textOf(drawn)).toContain('✚新規 1')
    expect(textOf(drawn)).toContain('○検索 1')
  })

  test('失敗・拒否された呼び出しは記録しない', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    await proc.tool({ tool: 'Read', file_path: `${ROOT}/pom.xml` }, { isError: true, result: 'denied', text: 'denied' })
    await proc.tool({ tool: 'Edit', file_path: `${ROOT}/pom.xml` }, { deny: 'no' })
    await proc.advance(FLUSH_MS)

    expect(Object.keys(proc.record().files)).toEqual([])
  })

  test('描き直しは間引く: FLUSH_MS の間に何度呼んでも $.state へは 1 回', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    await proc.advance(FLUSH_MS)
    proc.stateSets = []

    for (let i = 1; i <= 30; i++) {
      await proc.tool({ tool: 'Read', file_path: `${ROOT}/pom.xml` }, readResult(i, 1, 100))
    }

    expect(proc.stateSets).toEqual([])
    await proc.advance(FLUSH_MS)
    expect(proc.stateSets).toEqual(['touch-tree.record'])
    expect(proc.record().files[`${ROOT}/pom.xml`]?.ranges).toEqual([[1, 30]])
  })

  test('LSP は対象ファイルと、結果に出てきた実在ファイルを検索として数える', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    await proc.tool(
      { tool: 'LSP', operation: 'findReferences', filePath: `${JAVA}/web/ApiService.java`, line: 1, character: 1 },
      { result: { operation: 'findReferences', result: `Found 1 reference:\n${JAVA}/web/ApiController.java:\n  Line 3:4`, filePath: '' }, text: '' },
    )
    await proc.advance(FLUSH_MS)

    expect(Object.keys(proc.record().files).sort()).toEqual([`${JAVA}/web/ApiController.java`, `${JAVA}/web/ApiService.java`])
  })

  test('幅を変えても全行が bodyColumns に収まり、検証を通る', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `${JAVA}/module${i % 7}/sub${i % 3}/VeryLongClassNameForTesting${i}ServiceImpl.java`)
    const proc = new Process([...FILES, ...many])

    await proc.sessionStart()
    for (const path of many) await proc.tool({ tool: 'Read', file_path: path }, readResult(1, 10, 500))
    await proc.tool({ tool: 'Read', file_path: `${HOME}/.claude/CLAUDE.md` }, readResult(1, 10, 10))
    await proc.advance(FLUSH_MS)

    for (const columns of [16, 24, 40, 53, 66, 120]) {
      const drawn = await proc.pane(columns)

      expect(invalidReasonOf(drawn)).toBe('')

      const lines = treeLinesOf(drawn)

      expect(lines.length).toBeGreaterThan(40)
      for (const line of lines) expect(textWidth(line), `${columns} 桁: ${line}`).toBeLessThanOrEqual(columns)
    }
  })

  test('大きな記録でも 1 つの Text は 1 万文字を超えず、行数に上限がある', async () => {
    const proc = new Process([])

    await proc.sessionStart()
    await proc.advance(FLUSH_MS)

    const files: TouchTreeRecord['files'] = {}

    for (let i = 0; i < 3000; i++) {
      files[`${JAVA}/p${i % 40}/q${i % 13}/File${i}.java`] = { reads: 1, ranges: [], whole: true, edits: 0, created: false, hits: 0, seq: i }
    }

    proc.state.set('touch-tree.record', { root: ROOT, alias: '', home: HOME, files, seq: 3000, last: null })

    const drawn = await proc.pane(66)

    expect(invalidReasonOf(drawn)).toBe('')
    expect(treeLinesOf(drawn)).toHaveLength(MAX_ROWS)
    expect(textOf(drawn)).toContain('… ほか')
  })
})

describe('操作', () => {
  test('ボタン: 検索のみを隠す・クリア', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    await proc.tool({ tool: 'Read', file_path: `${ROOT}/pom.xml` }, readResult(1, 5, 5))
    await proc.tool({ tool: 'Bash', command: 'find src -name "*.java"' }, { result: {}, text: FILES.slice(0, 4).map(f => f.slice(ROOT.length + 1)).join('\n') })
    await proc.advance(FLUSH_MS)
    expect(treeLinesOf(await proc.pane(60)).length).toBeGreaterThan(4)

    await proc.emit('ui.press', { plugin: 'touch-tree', element: 'hits', component: 'Pane', requestId: PANE, surface: 'terminal' })
    expect(proc.state.get('touch-tree.showHits')).toBe(false)
    expect(proc.store.get('showHits')).toBe(false)

    const hidden = await proc.pane(60)

    expect(treeLinesOf(hidden)).toEqual(['example-app/ 1', '└ ● pom.xml 全5行'])
    expect(textOf(hidden)).toContain('検索に出ただけの 4 件を隠しています')

    await proc.emit('ui.press', { plugin: 'touch-tree', element: 'clear', component: 'Pane', requestId: PANE, surface: 'terminal' })
    expect(proc.record().files).toEqual({})
    expect(textOf(await proc.pane(60))).toContain('まだ何も触っていません')
  })

  test('帯の下に開け閉めボタンが 1 つだけ常にあり、押すたびに開閉する。ペインの中に「閉じる」は無い', async () => {
    const store = new Map<string, unknown>()
    const proc = new Process(FILES, store)
    const band = async (beneath: unknown = { type: 'engine', props: {}, children: [] }): Promise<Node> =>
      (await proc.emit(
        'ui.render',
        {
          surface: 'terminal',
          component: 'AbovePrompt',
          requestId: 'band',
          props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 } },
        },
        () => beneath,
      )) as Node
    const buttons = (node: Node) => flatten(node).filter(el => el.type === 'Button')
    const press = () =>
      proc.emit('ui.press', { plugin: 'touch-tree', element: 'touch-tree-toggle', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' })

    await proc.sessionStart()
    expect(buttons(await band()).map(b => b.props['label'])).toEqual(['touch-tree を開く'])

    await press()
    expect(proc.opened).toEqual([PANE])
    expect(store.get('open')).toBe(true)
    expect(buttons(await band()).map(b => b.props['label'])).toEqual(['touch-tree を閉じる'])
    expect(buttons(await proc.pane(60)).map(b => b.props['key']), 'ペインの中に閉じるボタンは置かない').not.toContain('close')

    const before = proc.invalidations

    await press()
    expect(proc.closed).toEqual([PANE])
    expect(store.get('open')).toBe(false)
    expect(proc.invalidations, '帯を描き直す').toBeGreaterThan(before)
    expect(buttons(await band()).map(b => b.props['label'])).toEqual(['touch-tree を開く'])

    // 他のプラグインの描画は消さず、ボタンはその下（帯のいちばん下）に置く
    const other = { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', props: {}, children: ['天気'] }] }
    const stacked = await band(other)

    expect(textOf(stacked)).toContain('天気')
    expect(typeof stacked !== 'string' && stacked.children.length).toBe(2)
    expect(typeof stacked !== 'string' && buttons(stacked.children[1] as Node).length).toBe(1)
  })

  test('/touch-tree で開き、次のセッションでも開く。人が閉じたら開かない', async () => {
    const store = new Map<string, unknown>()
    const first = new Process(FILES, store)

    await first.sessionStart()
    const answer = (await first.emit('command.run', { command: 'touch-tree', args: '' })) as { text: string }

    expect(first.opened).toEqual([PANE])
    expect(answer.text).toContain('開きました')
    expect(store.get('open')).toBe(true)

    const second = new Process(FILES, store)

    await second.sessionStart()
    expect(second.opened).toEqual([PANE])

    await second.emit('ui.close', { id: PANE, origin: { kind: 'person' } })
    expect(store.get('open')).toBe(false)

    const third = new Process(FILES, store)

    await third.sessionStart()
    expect(third.opened).toEqual([])
  })

  test('/clear で記録を空にする。reload（session.start のやり直し）では残す', async () => {
    const proc = new Process(FILES)

    await proc.sessionStart()
    await proc.tool({ tool: 'Read', file_path: `${ROOT}/pom.xml` }, readResult(1, 5, 5))
    await proc.advance(FLUSH_MS)

    // reload: モジュールの変数は消えるが、$.state は残る
    const reloaded = new Process(FILES)
    for (const [key, value] of proc.state) reloaded.state.set(key, value)
    await reloaded.sessionStart()
    await reloaded.tool({ tool: 'Edit', file_path: `${ROOT}/pom.xml` }, { result: {}, text: '' })
    await reloaded.advance(FLUSH_MS)
    expect(reloaded.record().files[`${ROOT}/pom.xml`]).toMatchObject({ reads: 1, edits: 1, whole: true })

    await reloaded.emit('session.end', { reason: 'clear' })
    expect(reloaded.record().files).toEqual({})
  })
})
