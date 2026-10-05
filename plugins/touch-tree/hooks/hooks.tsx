/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// エンジンは JSX を大域の `h` で組む。上のプラグマは、tsconfig を読まない場所から
// `bun test` したときも同じ組み方にするためのもの。
import type { EngineInterface, Register, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { TouchTreeRecord } from '../types'
import { applyTouches, canonical, countKinds, emptyRecord, normalizePath, readOfResult } from './record'
import type { Kind, Touching } from './record'
import { lspCandidates, outputCandidates, planBash, readsOf, searchToolCandidates } from './scan'
import { SYMBOLS, editorOf, editorUrl, fitRow, forestOf, rowsOf } from './tree'
import type { Editor } from './tree'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from './band'

/** プラグイン名。$.state と ui.press の持ち主。 */
const PLUGIN = 'touch-tree'

/** 帯の下に固定で置く開け閉めボタンの key。 */
const TOGGLE_BUTTON = 'touch-tree-toggle'

/** ペインの id（`$.ui.open` と ui.render の requestId）。 */
export const PANE = 'touch-tree'

/** 記録をまとめて $.state に書くまでの待ち（ミリ秒）。描き直しはこの間隔より細かくならない。 */
export const FLUSH_MS = 300

/** 1 回の呼び出しで実在を確かめるパスの上限。 */
const STAT_LIMIT = 400

/** ペインに出す行の上限（それより下は件数だけ）。 */
export const MAX_ROWS = 1500

/** 状態ごとの色。 */
export const COLORS: Record<Kind, string> = {
  created: '#4ade80',
  edited: '#fb923c',
  read: '#60a5fa',
  partial: '#a5b4fc',
  hit: '#9ca3af',
}

/** 罫線の色。 */
const GUIDE_COLOR = '#6b7280'

/** 凡例の並びと言葉。 */
const LEGEND: { kind: Kind; label: string }[] = [
  { kind: 'created', label: '新規' },
  { kind: 'edited', label: '編集' },
  { kind: 'read', label: '全体' },
  { kind: 'partial', label: '一部' },
  { kind: 'hit', label: '検索' },
]

// $.state の鍵。plugin と key はリテラルで書く（claude plugin validate が契約と照らす）。
// atom()/update() は 'claude-code' の実行時の import になり、エンジン無しの `bun test` で読み込めなく
// なるので使わず、$.state を直に読み書きする（書くのはこの Mod だけなので ifVersion の取り直しは要らない）。
const RECORD = { plugin: 'touch-tree', key: 'record' } as const
const SHOW_HITS = { plugin: 'touch-tree', key: 'showHits' } as const

/** 記録を読む（描画中に読めば、書き換えで描き直される）。 */
async function readRecord($: EngineInterface): Promise<TouchTreeRecord> {
  const { value } = await $.state.get(RECORD)

  return value ?? emptyRecord()
}

/** 検索に出ただけのファイルも出すか（既定は出す）。 */
async function readShowHits($: EngineInterface): Promise<boolean> {
  const { value } = await $.state.get(SHOW_HITS)

  return value ?? true
}

// ---- モジュールの状態（reload で消えるので、session.start で $.state から戻す） ----

/** 今の記録。ツール呼び出しのたびにここを更新し、FLUSH_MS ごとに $.state へ書く。 */
let book: TouchTreeRecord | null = null
/** 記録の初期化中の約束（同時に何度も始めないため）。 */
let starting: Promise<void> | null = null
/** $.state への書き出し待ちのタイマー。 */
let flushTimer: Timer | null = null

/** ペインが開いているか。閉じているあいだだけ、帯に「開く」ボタンを出す。 */
let isPaneOpen = false

/**
 * リポジトリのルート（git のトップ）と、その別名の綴りを決める。
 *
 * git はシンボリックリンクを解いたパスを返すので、セッションのルートが `/tmp/x` のように
 * リンク越しなら、その綴りを別名として覚えておき、記録するときに直す。
 */
async function rootsOf($: EngineInterface): Promise<{ root: string; alias: string }> {
  let sessionRoot = ''

  try {
    sessionRoot = await $.session.root()
  } catch {
    // ルートが取れなければ、全部を外部として出す。
    return { root: '', alias: '' }
  }

  let root = sessionRoot

  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: sessionRoot, timeoutMs: 5000 })
    const top = ran.stdout.trim()

    if (ran.exitCode === 0 && top.startsWith('/')) root = top
  } catch {
    // git が無くても、セッションのルートを根にする。
  }

  if (root === sessionRoot || sessionRoot.startsWith(root + '/')) {
    return { root, alias: '' }
  }

  try {
    const real = (await $.fs.stat(sessionRoot, { resolve: true })).realPath ?? ''
    const suffix = real === root ? '' : real.startsWith(root + '/') ? real.slice(root.length) : undefined

    if (suffix !== undefined && sessionRoot.endsWith(suffix)) {
      return { root, alias: sessionRoot.slice(0, sessionRoot.length - suffix.length) }
    }
  } catch {
    // 解けなければ別名なし。
  }

  return { root, alias: '' }
}

/** 記録を $.state から戻し、ルートとホームを決め直す。 */
async function start($: EngineInterface): Promise<void> {
  const kept = await readRecord($)
  const { root, alias } = await rootsOf($)
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''

  book = { ...kept, root, alias, home }
  scheduleFlush($)
}

/** 記録が使えるようにする（session.start より先にツールが来たときも）。 */
async function ready($: EngineInterface): Promise<TouchTreeRecord> {
  if (book === null) {
    starting ??= start($)
    await starting
  }

  return book ?? emptyRecord()
}

/** $.state への書き出しを予約する。予約済みなら何もしない（描き直しを間引く）。 */
function scheduleFlush($: EngineInterface): void {
  if (flushTimer !== null) return

  flushTimer = $.clock.after(FLUSH_MS, () => {
    flushTimer = null
    void flush($)
  })
}

/** 今の記録を $.state に書く（ペインが描き直される）。 */
async function flush($: EngineInterface): Promise<void> {
  const snapshot = book

  if (snapshot !== null) await $.state.set(RECORD, snapshot)
}

/** 触り方を記録に足す。 */
async function mark($: EngineInterface, touches: readonly Touching[]): Promise<void> {
  if (touches.length === 0) return

  const current = await ready($)

  book = applyTouches(
    current,
    touches.map(t => ({ ...t, path: canonical(t.path, current.root, current.alias) })),
  )
  scheduleFlush($)
}

/** 実在する（ディレクトリでない）ファイルだけを残す。 */
async function existingFiles($: EngineInterface, paths: readonly string[]): Promise<string[]> {
  const unique = [...new Set(paths)].slice(0, STAT_LIMIT)
  const checked = await Promise.all(
    unique.map(path =>
      $.fs.stat(path).then(
        stat => (stat.kind === 'file' ? path : undefined),
        () => undefined,
      ),
    ),
  )

  return checked.filter((path): path is string => path !== undefined)
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 1 回のツール呼び出しから、触ったファイルを拾って記録する。
 *
 * @param cwd 呼び出しの直前のシェルの作業ディレクトリ
 */
async function observe($: EngineInterface, e: ToolCallInput, ran: ToolCallResult, cwd: string): Promise<void> {
  if (ran.deny !== undefined) return

  const tool = String(e.tool)
  const input = e as unknown as Record<string, unknown>
  const { home } = await ready($)
  const pathOf = (raw: unknown): string | undefined => normalizePath(asString(raw), cwd, home)

  // Bash は終了コードが 0 でなくても（grep の不一致など）出力は見る。それ以外は失敗なら何もしない。
  if (tool !== 'Bash' && ran.isError === true) return

  const result = ran.result as Record<string, unknown> | undefined

  if (tool === 'Read') {
    const path = pathOf(input['file_path'])
    if (path !== undefined) await mark($, [{ path, read: readOfResult(ran.result) }])
    return
  }

  if (tool === 'Edit' || tool === 'NotebookEdit') {
    if (result?.['staged'] === true) return
    const path = pathOf(input[tool === 'Edit' ? 'file_path' : 'notebook_path'])
    if (path !== undefined) await mark($, [{ path, edit: true }])
    return
  }

  if (tool === 'Write') {
    const path = pathOf(input['file_path'])
    if (path !== undefined) await mark($, [result?.['type'] === 'create' ? { path, create: true } : { path, edit: true }])
    return
  }

  if (tool === 'LSP') {
    const target = pathOf(input['filePath'])
    const found = await existingFiles($, lspCandidates(asString(result?.['result']) || (ran.text ?? ''), cwd, home))
    const hits = [...(target === undefined ? [] : [target]), ...found]
    await mark($, hits.map(path => ({ path, hit: true })))
    return
  }

  if (tool === 'Grep' || tool === 'Glob') {
    const base = pathOf(input['path']) ?? cwd
    const found = await existingFiles($, searchToolCandidates(ran.result, ran.text ?? '', base, home))
    await mark($, found.map(path => ({ path, hit: true })))
    return
  }

  if (tool === 'Bash') {
    const plan = planBash(asString(input['command']), cwd, home)
    const reads = readsOf(plan)
    const scanned = plan.scanBase === null ? [] : outputCandidates(ran.text ?? '', plan.scanBase, home)
    const real = new Set(await existingFiles($, [...reads.map(r => r.path), ...plan.named, ...scanned]))
    const readPaths = new Set(reads.map(r => r.path))
    const hits = [...new Set([...plan.named, ...scanned])].filter(path => real.has(path) && !readPaths.has(path))

    await mark($, [...reads.filter(r => real.has(r.path)), ...hits.map(path => ({ path, hit: true as const }))])
  }
}

/** 記録を空にする。 */
async function clearRecord($: EngineInterface): Promise<void> {
  const current = await ready($)

  book = emptyRecord(current.root, current.alias, current.home)
  await flush($)
}

/** 検索に出ただけのファイルを出すかを切り替え、次のセッションにも残す。 */
async function toggleHits($: EngineInterface): Promise<boolean> {
  const next = !(await readShowHits($))

  await $.state.set(SHOW_HITS, next)
  await $.store.set('showHits', next)

  return next
}

/** ペインの開閉を覚え、帯のボタンを出し入れするために描き直す。 */
function setPaneOpen($: EngineInterface, open: boolean): void {
  if (isPaneOpen === open) return

  isPaneOpen = open
  $.ui.invalidate('ui.render')
}

/** ペインを閉じ、次のセッションでも開かないよう覚える。 */
async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  await $.store.set('open', false)
  setPaneOpen($, false)
}

/** ペインを開き、次のセッションでも開くよう覚える。 */
async function openPane($: EngineInterface): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: 'touch-tree' })

  await $.store.set('open', true)
  setPaneOpen($, true)

  return opened.isPlaced ? '' : opened.reason
}

/**
 * このセッションで Claude（サブエージェント含む）が読んだ・書いたファイルを、
 * リポジトリのツリーに沿ってペインに出す。
 *
 * @param on エンジンの登録口
 */
/** ファイルの行のボタンの key の頭（後ろにファイルの絶対パス）。 */
export const OPEN_PREFIX = 'open:'

/** ファイルをエディタで開く（macOS は open、それ以外は xdg-open に URL を渡す）。開けなければトーストで知らせる。 */
async function openInEditor($: EngineInterface, editor: Editor, path: string): Promise<void> {
  const url = editorUrl(editor, path)

  if (url === null) return

  for (const opener of ['open', 'xdg-open']) {
    try {
      const { exitCode, stderr } = await $.process.run([opener, url], { timeoutMs: 10_000 })

      if (exitCode === 0) return

      $.ui.toast(`開けませんでした: ${stderr.trim().split('\n')[0] ?? ''}`.trim(), { timeoutMs: 5_000 })

      return
    } catch {
      // このコマンドが無い。次を試す。
    }
  }

  $.ui.toast('ファイルを開くコマンド（open / xdg-open）が見つかりません', { timeoutMs: 5_000 })
}

export const register: Register = (on, options) => {
  const editor = editorOf(options['editor'])

  on('session.start', async ($, e, next) => {
    flushTimer?.cancel()
    flushTimer = null
    book = null
    starting = start($)
    await starting

    const showHits = await $.store.get('showHits')

    if (typeof showHits === 'boolean') await $.state.set(SHOW_HITS, showHits)

    await $.command.register({
      name: 'touch-tree',
      description: '読んだ・編集したファイルをリポジトリのツリーで出すペインを開く（引数: clear / hits / close）',
    })

    // 前のセッションで開いていたら、今回も開く（頼まれずに開くので、狭い端末では幅が空くまで待つ）。
    if ((await $.store.get('open')) === true) {
      setPaneOpen($, true)
      void $.ui.open({ id: PANE, title: 'touch-tree' })
    } else {
      setPaneOpen($, false)
    }

    return next(e)
  })

  // /clear では会話の文脈が空になるので、記録も空にする（session.start は来ない）。
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await clearRecord($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let cwd = ''

    try {
      cwd = await $.session.cwd()
    } catch {
      cwd = ''
    }

    const ran = await next(e)

    try {
      await observe($, e, ran, cwd)
    } catch {
      // 記録に失敗しても、ツールの結果には手を出さない。
    }

    return ran
  })

  on('command.run', { command: 'touch-tree' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] ?? ''

    if (sub === 'clear') {
      await clearRecord($)
      return { text: 'touch-tree: 記録を空にしました' }
    }

    if (sub === 'hits') {
      const shown = await toggleHits($)
      return { text: shown ? 'touch-tree: 検索に出ただけのファイルも出します' : 'touch-tree: 検索に出ただけのファイルは隠します' }
    }

    if (sub === 'close') {
      await closePane($)
      return { text: 'touch-tree: ペインを閉じました' }
    }

    const reason = await openPane($)

    return { text: reason === '' ? 'touch-tree: ペインを開きました' : `touch-tree: ペインを置けませんでした（${reason}）` }
  })

  // ペインのボタン。押した処理は $ をクロージャに閉じ込めず、ここで行う。
  on('ui.press', async ($, e, next) => {
    if (e.plugin === PLUGIN && e.requestId === PANE) {
      if (e.element === 'hits') await toggleHits($)
      if (e.element === 'clear') await clearRecord($)
      if (e.element.startsWith(OPEN_PREFIX)) await openInEditor($, editor, e.element.slice(OPEN_PREFIX.length))
    }

    // 帯の開け閉めボタン。開いていれば閉じ、閉じていれば開く。
    if (e.plugin === PLUGIN && e.component === 'AbovePrompt' && e.element === TOGGLE_BUTTON) {
      if (isPaneOpen) await closePane($)
      else await openPane($)
    }

    return next(e)
  })

  // 人が × で閉じたら、次のセッションでは開かない。
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('open', false)
    if (e.id === PANE) setPaneOpen($, false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const record = await readRecord($)
    const showHits = await readShowHits($)
    const columns = Math.max(10, e.props.bodyColumns || e.viewport?.columns || 40)
    const forest = forestOf(record, showHits)
    const rows = rowsOf(forest, record.last)
    const shown = rows.slice(0, MAX_ROWS).map(row => fitRow(row, columns))
    const counts = countKinds(record.files)
    const legend = LEGEND.filter(item => counts[item.kind] > 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {legend.length === 0 ? (
            <Text dimColor>まだ何も触っていません</Text>
          ) : (
            legend.map(item => (
              <Text color={COLORS[item.kind]}>{`${SYMBOLS[item.kind]}${item.label} ${counts[item.kind]}`}</Text>
            ))
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="hits" label={showHits ? '検索のみを隠す' : '検索のみも出す'} onPress={() => undefined} />
          <Button key="clear" label="クリア" onPress={() => undefined} />
        </Box>
        <Text color={GUIDE_COLOR}>{'─'.repeat(Math.min(columns, 500))}</Text>
        {forest.hidden > 0 && <Text dimColor wrap="truncate-end">{`検索に出ただけの ${forest.hidden} 件を隠しています`}</Text>}
        {shown.map((row, index) => {
          const color = row.kind === 'file' && row.state !== undefined ? COLORS[row.state] : undefined
          // ファイルの行は押すとエディタで開くボタンにする（フォルダは開くと新しいウィンドウになりがちなので、しない）。
          // 全画面の端末ではリンクのクリックをアプリが受け取ってしまい開かないので、Link ではなく Button で自分で開く。
          // ボタンの文字には色を付けられないので、状態の色は先頭の記号で見分ける。
          const canOpen = row.kind === 'file' && editorUrl(editor, row.path) !== null

          return (
            <Box key={`row-${index}`} flexDirection="row">
              {row.guide !== '' && <Text color={GUIDE_COLOR}>{row.guide}</Text>}
              {row.symbol !== '' && <Text color={color}>{row.symbol}</Text>}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {canOpen ? (
                  <Button key={`${OPEN_PREFIX}${row.path}`} label={row.name} plain dimColor={row.state === 'hit'} onPress={() => undefined} />
                ) : (
                  <Text color={color} bold={row.kind !== 'file' || row.isLast === true} underline={row.isLast === true} wrap="truncate-end">
                    {row.name}
                  </Text>
                )}
              </Box>
              {row.meta !== '' && (
                <Box flexShrink={0}>
                  <Text dimColor>{` ${row.meta}`}</Text>
                </Box>
              )}
            </Box>
          )
        })}
        {rows.length > shown.length && <Text dimColor>{`… ほか ${rows.length - shown.length} 行`}</Text>}
      </Box>
    )
  })
  // プロンプトの上の帯に開け閉めボタンを 1 行だけ固定で置く。
  // 帯を使う他のプラグインの描画は先に受け取り、並び順（band.ts）どおりに積み直す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)

    if (e.surface !== 'terminal' || e.props.hasSurvey || e.props.maxRows < 2) return beneath

    const { Box, Button } = $.ui.resolve(e)
    const button = (
      <Box key={slotKey(BAND_ORDER.touchTreeToggle, 'touch-tree')} flexDirection="row">
        <Button
          key={TOGGLE_BUTTON}
          label={isPaneOpen ? 'touch-tree を閉じる' : 'touch-tree を開く'}
          dimColor
          onPress={() => undefined}
        />
      </Box>
    )

    return (
      <Box key={BAND_STACK} flexDirection="column">
        {stackBand(beneath, [button])}
      </Box>
    )
  })
}
