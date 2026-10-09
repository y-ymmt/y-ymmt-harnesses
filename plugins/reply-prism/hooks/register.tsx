// reply-prism の入口。本家 prismantis の hooks/register.tsx を元に、次を足している:
// - ファイルパスのリンク（作業ディレクトリとホームを覚え、端末で描くときだけリンクにする）
// - 押してエディタで開くボタン（ツール行のパスと返事の最後の「開く:」の行。全画面表示の端末向け）
// - 表・コードの開閉と表の並べ替え（状態は $.state の `reply-prism.view` に、メッセージごとに置く）
// - 表のコピー形式（Markdown・TSV・Slack）と、ボタン・トーストの日本語化
// - コマンド名を `/reply-prism` に（本家の `/prismantis` と衝突しないように）
// - 注意箇所の注記（DANGER_HINT）: 返事を書く Claude に、特に注意すべき箇所を `==…==` で囲ませる
// - 返事まるごとコピー: 返事の最後のテキストブロックの下に「コピー:」と形式ごとのボタン（会話は $.session.messages() で読む）。
//   Slack は macOS なら書式付き（HTML）でクリップボードに入れる（clipboard.ts）
import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { ReplyPrismView } from '../types'
import type { RichText } from './clipboard'
import { PASTEBOARD_ARGV, pasteboardInput } from './clipboard'
import { chip } from './chip'
import { DANGER_HINT } from './mark'
import { parse } from './markdown'
import { boxArt, fittedMermaid } from './mermaid'
import type { OpenTarget } from './paths'
import { editorUrl, makeLinker, makeResolver, parseOpenKey, parseUrlKey } from './paths'
import type { Controls, CopyButton, Drawn } from './render'
import { COPY, openButtons, openTargets, remember, renderBlocks, renderExpandedShell, renderOpenRow, renderReplyCopyRow, renderToolGroup, renderToolRow, renderTurnDuration } from './render'
import type { TranscriptRow } from './reply'
import { findReply } from './reply'
import { helpText, rtlShowcaseText, showcaseText } from './help'
import { PRESET_NAMES } from './presets'
import { nextSort } from './table'
import type { Style } from './theme'
import { desktopThemeOf, resolveStyle } from './theme'
import type { Terminal } from './rtl'
import { TERMINALS, hasRtl } from './rtl'

const HINT = [
  'Replies in this session are drawn by the reply-prism mod, which runs inside Claude Code and is not a command or tool to call: when the user asks to show something with reply-prism, write it as markdown in the reply.',
  'Markdown tables, GitHub alerts (> [!WARNING], > [!NOTE]), fenced code with a language tag, and ```mermaid blocks render as colored terminal graphics:',
  'flowcharts, sequence diagrams and xychart-beta bar or line charts.',
  'When a reply carries a numeric series or a flow that is easier to see than read, add one small diagram or chart with short labels.',
  'Skip diagrams for simple answers.',
].join(' ')

/** 表・コードの開閉と並べ替えの状態。メッセージ（requestId）ごとに 1 つ。 */
const VIEW = atom({ plugin: 'reply-prism', key: 'view' } as const, {})

/** メインのターンが走っているか。ターンの始めと終わりに書き、会話の最後の返事のブロックが読む（返事まるごとコピー）。 */
const TURN = atom({ plugin: 'reply-prism', key: 'turn' } as const, { running: false, n: 0 })

const detectTerminal = async ($: EngineInterface): Promise<Terminal | null> => {
  const program = await $.env.get('TERM_PROGRAM')
  const term = await $.env.get('TERM')
  if ((await $.env.get('KITTY_WINDOW_ID')) || term === 'xterm-kitty') return 'kitty'
  if (program === 'Apple_Terminal') return 'apple-terminal'
  if (program === 'WarpTerminal') return 'warp'
  if (program === 'ghostty') return 'ghostty'
  if (program === 'WezTerm') return 'wezterm'
  if (program === 'vscode') return 'vscode'
  if (program === 'iTerm.app') return 'iterm'
  if (term === 'alacritty' || (await $.env.get('ALACRITTY_WINDOW_ID'))) return 'alacritty'
  if (await $.env.get('WT_SESSION')) return 'windows-terminal'
  if (await $.env.get('VTE_VERSION')) return 'gnome'
  if (await $.env.get('KONSOLE_VERSION')) return 'konsole'
  return null
}

const applyRtl = async ($: EngineInterface, styles: readonly Style[]): Promise<void> => {
  if (styles[0]?.rtl !== 'auto') return
  const terminal = await detectTerminal($)
  for (const style of styles) {
    style.reorder = terminal !== null
    if (terminal) style.shape = TERMINALS[terminal]
  }
}

/** 相対パスを絶対にするための作業ディレクトリとホーム。セッション開始とプロンプト送信のたびに取り直す。 */
const learnWhere = async ($: EngineInterface, where: { cwd: string; home: string }): Promise<void> => {
  where.cwd = await $.session.cwd().catch(() => where.cwd)
  where.home = (await $.env.get('HOME').catch(() => undefined)) ?? where.home
}

/** 開いたツール呼び出しの id を覚える数の上限。古いものから忘れる（長いセッションで増え続けないように）。 */
const EXPANDED_LIMIT = 1000

/** 上限つきで id を覚える。register のクロージャに 1 つ作る（セッション・Mod の読み込みごとに別）。 */
export const makeExpandedCalls = (limit = EXPANDED_LIMIT) => {
  const seen = new Set<string>()
  return {
    add: (id: string) => {
      seen.delete(id)
      seen.add(id)
      if (seen.size > limit) seen.delete(seen.values().next().value!)
    },
    has: (id: string) => seen.has(id),
    get size() {
      return seen.size
    },
  }
}

/**
 * URL を macOS は open、それ以外は xdg-open に渡して開く。開けなければトーストで知らせる。
 * 全画面表示の端末ではリンク（OSC 8）のクリックが Mod に届かず開かないため、ボタンからこれを呼ぶ。
 */
const openUrl = async ($: EngineInterface, url: string, what = 'リンク'): Promise<void> => {
  let lastError = ''
  for (const opener of ['open', 'xdg-open']) {
    try {
      const { exitCode, stderr } = await $.process.run([opener, url], { timeoutMs: 10_000 })
      if (exitCode === 0) return
      // 失敗したら、次のコマンドも試す（macOS 以外では open が別物のことがある）。
      lastError = stderr.trim().split('\n')[0] ?? ''
    } catch {
      // このコマンドが無い。次を試す。
    }
  }
  if (lastError) {
    $.ui.toast(`開けませんでした: ${lastError}`.trim(), { timeoutMs: 5_000 })
    return
  }
  $.ui.toast(`${what}を開くコマンド（open / xdg-open）が見つかりません`, { timeoutMs: 5_000 })
}

/** ファイルをエディタで開く（エディタの URL を作って openUrl に渡す）。 */
const openInEditor = async ($: EngineInterface, style: Style, target: OpenTarget): Promise<void> => {
  const url = editorUrl(style.editor, style.editorUrlTemplate, target.abs, target.line, target.col)
  if (url !== undefined) await openUrl($, url, 'ファイル')
}

// ---- 書式付きのコピー（macOS） ----

/** 手元の macOS か（分かったら覚える）。register が 1 つ作り、押されるたびに writeRichText に渡す。 */
type RichClipboard = { isLocalMac?: boolean }

/**
 * 手元の macOS か。`uname -s` が `Darwin` で、SSH 越しでない（SSH 先の Mac のクリップボードは手元のものではない）。
 * コマンドが走らなかったときは undefined（覚えずに、次の押下でまた見る）。
 */
const detectLocalMac = async ($: EngineInterface): Promise<boolean | undefined> => {
  if ((await $.env.get('SSH_CONNECTION').catch(() => undefined)) || (await $.env.get('SSH_TTY').catch(() => undefined))) return false
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 })
    return exitCode === 0 && stdout.trim() === 'Darwin'
  } catch {
    return undefined
  }
}

/**
 * 書式付き（HTML とプレーンテキスト）でクリップボードに入れる（clipboard.ts の JXA）。入れられたら true。
 * macOS でない・SSH 越し・osascript が無い・失敗したら false（呼ぶ側が `$.ui.copy` で文字だけを入れる）。
 */
const writeRichText = async ($: EngineInterface, clipboard: RichClipboard, content: RichText): Promise<boolean> => {
  clipboard.isLocalMac ??= await detectLocalMac($)
  if (!clipboard.isLocalMac) return false
  try {
    const { exitCode, stdout } = await $.process.run(PASTEBOARD_ARGV, { stdin: pasteboardInput(content), timeoutMs: 10_000 })
    return exitCode === 0 && stdout.trim() === 'ok'
  } catch {
    return false
  }
}

/**
 * コピーボタン。書式付き（`rich`）があれば先にそれを試す（macOS の端末・デスクトップ・VS Code。クリップボードは Claude Code が
 * 動いている機械のものなので、モバイルでは試さない）。入れられなければ今まで通り `$.ui.copy` で文字だけを入れる。
 */
const makeCopy = ($: EngineInterface, el: ReturnType<EngineInterface['ui']['resolve']>, style: Style, clipboard?: RichClipboard): CopyButton => {
  const { Button } = el
  return (text, key, label = COPY, done = 'コピーしました', rich) =>
    style.copyButtons ? chip(el, style, key, (
      <Button
        key={key}
        variant="primary"
        label={label}
        onPress={press => {
          void (async () => {
            if (rich && clipboard && press.surface !== 'mobile' && (await writeRichText($, clipboard, rich.content()))) {
              $.ui.toast(rich.done)
              return
            }
            const value = typeof text === 'function' ? text() : text
            const r = await $.ui.copy({ text: value, surface: press.surface })
            $.ui.toast(r.isCopied ? done : `コピーできませんでした: ${r.reason}`)
          })().catch(() => $.ui.toast('コピーできませんでした'))
        }}
      />
    )) : null
}

// ---- 返事まるごとコピー ----
// 描画には自分のテキストブロックの文しか来ない（`isFirstOfReply` もツール呼び出しの後のブロックごとに true になる）ので、
// 会話を読んで、そのブロックが入る返事と、それが返事の最後のテキストブロックかを決める。
// 会話は描画のたびに読むと重いので、ターンの始めと終わりまで使い回す（ブロックが見つからなければ 1 秒おきに読み直す）。
type TranscriptCache = { current?: { at: number; rows: readonly TranscriptRow[] } }

/** 会話の記録を読み直すまでの間隔。間隔ごとに読み直し、行数か最後の行が変わっていたら（/compact・/rewind・再開）覚えを捨てる。 */
const TRANSCRIPT_TTL_MS = 1000

const rowsSignature = (rows: readonly TranscriptRow[]): string => {
  const last = rows[rows.length - 1]
  return `${rows.length}\0${last?.role ?? ''}\0${last?.text ?? ''}`
}

const readTranscript = async ($: EngineInterface, cache: TranscriptCache): Promise<readonly TranscriptRow[]> => {
  const now = Date.now()
  const hit = cache.current
  if (hit && now - hit.at < TRANSCRIPT_TTL_MS) return hit.rows
  const rows = await $.session.messages().then(r => (Array.isArray(r) ? r : []), () => [] as TranscriptRow[])
  // 変わっていなければ、同じ配列を使い回す（splitReplies の覚えが効く）。
  cache.current = { at: now, rows: hit && rowsSignature(hit.rows) === rowsSignature(rows) ? hit.rows : rows }
  return cache.current.rows
}

/** このブロックの下に「コピー:」の行を出すなら、その返事のテキストブロックの文。出さないなら undefined。 */
const replyTexts = async ($: EngineInterface, style: Style, cache: TranscriptCache, text: string): Promise<string[] | undefined> => {
  if (!style.replyCopy) return undefined
  const found = findReply(await readTranscript($, cache), text)
  // 会話の最後の返事はターンが終わるまで続きが来るかもしれない。そのブロックと見つからないブロックはターンの状態を読み、
  // ターンの始めと終わりに描き直させる（返事が終わってから、最後のテキストブロックの下にだけ出る）。古い返事は読まない。
  if (!found || found.isLatest) {
    const turn = await read($, TURN).catch(() => TURN.initial)
    if (!found || turn.running) return undefined
  }
  return found.isLast ? found.texts : undefined
}

/** ブロックの開閉・並べ替えを $.state に書く手段。押したときだけ書く（描画中は書けない）。 */
const makeControls = ($: EngineInterface, e: { requestId: string }, view: ReplyPrismView): Controls => {
  const ref = memberOf(VIEW, e)
  return {
    view,
    toggle: id => {
      void update($, ref, all => ({ ...all, [id]: { ...all[id], open: all[id]?.open !== true } })).catch(() => $.ui.toast('開閉できませんでした'))
    },
    sort: (id, col) => {
      void update($, ref, all => {
        const { sortCol, sortDir, ...rest } = all[id] ?? {}
        const next = nextSort({ ...(sortCol !== undefined ? { col: sortCol } : {}), ...(sortDir ? { dir: sortDir } : {}) }, col)
        return { ...all, [id]: next.col !== undefined && next.dir ? { ...rest, sortCol: next.col, sortDir: next.dir } : rest }
      }).catch(() => $.ui.toast('並べ替えできませんでした'))
    },
  }
}

const drawMarkdown = ($: EngineInterface, el: ReturnType<EngineInterface['ui']['resolve']>, style: Style, blocks: ReturnType<typeof parse>, columns: number, controls?: Controls): RenderElement[] => {
  const drawn: Drawn = new Map()
  if (style.mermaid) {
    for (const [i, block] of blocks.entries()) {
      if (block.kind !== 'code' || block.lang.toLowerCase() !== 'mermaid') continue
      const art = fittedMermaid(block.lines.join('\n'), style.mermaidAscii, columns, columns - 2)
      if (art !== null) drawn.set(i, { element: boxArt(el, style, art, `b${i}`), art })
    }
  }
  return renderBlocks(el, style, blocks, columns, drawn, makeCopy($, el, style), controls)
}

/** 状態を読むのは、開閉・並べ替えのある表・コードがあるときだけ（読むと描き直しの対象になるため）。 */
const readControls = async ($: EngineInterface, e: { requestId: string }, blocks: ReturnType<typeof parse>): Promise<Controls | undefined> => {
  if (!blocks.some(b => b.kind === 'table' || b.kind === 'code')) return undefined
  const view = await read($, memberOf(VIEW, e)).catch(() => ({}))
  return makeControls($, e, view)
}


/** 「開く:」の行に出すファイルが実在するか。描き直しのたびに調べないよう、パスごとに少しの間覚えておく。 */
const EXISTS_TTL_MS = 5_000
export const EXISTS_LIMIT = 500
export type ExistsCache = Map<string, { exists: boolean; at: number }>

export async function existingFiles($: EngineInterface, cache: ExistsCache, paths: readonly string[]): Promise<Map<string, boolean>> {
  const now = Date.now()
  const out = new Map<string, boolean>()
  await Promise.all(
    [...new Set(paths)].map(async abs => {
      const hit = cache.get(abs)
      if (hit && now - hit.at < EXISTS_TTL_MS) return void out.set(abs, hit.exists)
      let exists = false
      try {
        exists = await $.fs.exists(abs)
      } catch {
        exists = false
      }
      cache.delete(abs)
      cache.set(abs, { exists, at: now })
      if (cache.size > EXISTS_LIMIT) cache.delete(cache.keys().next().value!)
      out.set(abs, exists)
    }),
  )
  return out
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const resolved = resolveStyle(options)
  // 端末以外（デスクトップアプリなど）は白地のことが多いので、配色は `desktopTheme` のものにする
  const style: Style = { ...resolved, theme: desktopThemeOf(options) }
  const where = { cwd: '', home: '' }
  // パスのリンク（OSC 8）は端末でだけ描く。デスクトップなどは https 以外のリンクを描かないため。
  const terminalStyle: Style = { ...resolved, fileLinks: makeLinker(style.editor, style.editorUrlTemplate, where), fileTargets: makeResolver(style.editor, style.editorUrlTemplate, where) }
  const styles = [style, terminalStyle] as const
  const styleFor = (surface: string): Style => (surface === 'terminal' ? terminalStyle : style)
  const clipboard: RichClipboard = {}
  const transcriptCache: TranscriptCache = {}
  const existsCache: ExistsCache = new Map()
  const expandedCalls = makeExpandedCalls()
  const parsed = new Map<string, ReturnType<typeof parse>>()
  const parseCached = (text: string) => remember(parsed, text, () => parse(text, { numbers: style.highlightNumbers, paths: style.highlightPaths }))

  // 返事まるごとコピー: ターンの始めと終わりに会話の読み直しとターンの状態の書き込み（描き直させる）。
  if (style.replyCopy) {
    on('turn.start', async ($, e, next) => {
      transcriptCache.current = undefined
      void update($, TURN, t => ({ running: true, n: t.n + 1 })).catch(() => undefined)
      return next(e)
    })
    on('turn.complete', async ($, e, next) => {
      const done = await next(e)
      // サブエージェントのターンはメインの返事を変えない。
      if (e.agentId === undefined) {
        transcriptCache.current = undefined
        await update($, TURN, t => ({ running: false, n: t.n + 1 })).catch(() => undefined)
      }
      return done
    })
  }

  if (options.toolRows !== false) {
    on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
      if (e.props.isExpanded) {
        for (const call of e.props.calls) if (call.tool_use_id) expandedCalls.add(call.tool_use_id)
        return next(e)
      }
      return renderToolGroup($.ui.resolve(e), styleFor(e.surface), e.props.calls, e.props.isActive)
    })
    on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
      if (!expandedCalls.has(e.props.tool_use_id)) return renderToolRow($.ui.resolve(e), styleFor(e.surface), e.props)
      return e.props.tool === 'Bash' || e.props.tool === 'PowerShell' ? renderExpandedShell($.ui.resolve(e), styleFor(e.surface), e.props) : next(e)
    })
  }

  on('session.start', async ($, e, next) => {
    transcriptCache.current = undefined
    await applyRtl($, styles)
    await learnWhere($, where)
    const started = await next(e)
    await $.command
      .register({ name: 'reply-prism', description: 'reply-prism のテーマを切り替える・一覧を出す', argumentHint: '[theme <name> | demo | demo-rtl]' })
      .catch(() => undefined)
    return started
  })

  on('command.run', { command: 'reply-prism' }, async ($, e) => {
    const [sub, name] = e.args.trim().split(/\s+/)
    if (sub === 'demo') return { text: showcaseText(PRESET_NAMES) }
    if (sub === 'demo-rtl') {
      await applyRtl($, styles)
      return { text: rtlShowcaseText() }
    }
    if (sub !== 'theme' || !name) return { text: helpText(PRESET_NAMES) }
    if (!(PRESET_NAMES as readonly string[]).includes(name)) return { text: `テーマ「${name}」はありません。テーマ: ${PRESET_NAMES.join(', ')}` }
    const result = await $.config.set({ key: `${$.plugin.name}.theme`, value: name })
    return { text: result.deny ? `テーマを切り替えられませんでした: ${result.deny}` : `テーマを ${name} にしました。` }
  })

  // 押して開くボタン（ツール行のパスと、返事の最後の「開く:」の行のファイル・URL）。開く対象は key から戻す。
  // 他のボタン（コピー・開閉・並べ替え）は onPress で動くので、そのまま下へ流す。
  on('ui.press', async ($, e, next) => {
    const isMine = e.plugin === $.plugin.name
    const target = isMine ? parseOpenKey(e.element) : undefined
    const url = isMine ? parseUrlKey(e.element) : undefined
    if (target) await openInEditor($, style, target)
    else if (url) await openUrl($, url)
    return next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e) => renderTurnDuration($.ui.resolve(e), styleFor(e.surface), e.props.word, e.props.durationMs))

  on('prompt.submit', async ($, e, next) => {
    await applyRtl($, styles)
    await learnWhere($, where)
    const hints = [...(style.diagramHints ? [HINT] : []), ...(style.dangerHints ? [DANGER_HINT] : [])]
    if (hints.length === 0 || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...hints] })
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const s = styleFor(e.surface)
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const controls = await readControls($, e, blocks)
    return <Box flexDirection="column" rowGap={1} {...(s.reorder && hasRtl(e.props.text) ? { width: '100%' } : {})}>{drawMarkdown($, el, s, blocks, columns, controls)}</Box>
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const base = styleFor(e.surface)
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const controls = await readControls($, e, blocks)
    const whole = await replyTexts($, base, transcriptCache, e.props.text)
    const known = await existingFiles($, existsCache, openTargets(base, blocks).map(t => t.abs))
    // 「開く:」の行のボタンを先に決め、URL のボタンの番号を本文のリンクにも付ける
    const buttons = openButtons(base, blocks, abs => known.get(abs) === true)
    const s = buttons.linkNumbers.size > 0 ? { ...base, linkNumbers: buttons.linkNumbers } : base
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={s.theme.accent}>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          {drawMarkdown($, el, s, blocks, columns, controls)}
          {renderOpenRow(el, s, buttons)}
          {whole ? renderReplyCopyRow(el, s.replyCopyFormats, whole, makeCopy($, el, { ...s, copyButtons: true }, clipboard)) : null}
        </Box>
      </Box>
    )
  })
}
