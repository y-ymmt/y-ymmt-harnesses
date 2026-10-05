// reply-prism の入口。本家 prismantis の hooks/register.tsx を元に、次を足している:
// - ファイルパスのリンク（作業ディレクトリとホームを覚え、端末で描くときだけリンクにする）
// - 押してエディタで開くボタン（ツール行のパスと返事の最後の「開く:」の行。全画面表示の端末向け）
// - 表・コードの開閉と表の並べ替え（状態は $.state の `reply-prism.view` に、メッセージごとに置く）
// - 表のコピー形式（Markdown・TSV・Slack）と、ボタン・トーストの日本語化
// - コマンド名を `/reply-prism` に（本家の `/prismantis` と衝突しないように）
// - 注意箇所の注記（DANGER_HINT）: 返事を書く Claude に、特に注意すべき箇所を `==…==` で囲ませる
import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { ReplyPrismView } from '../types'
import { DANGER_HINT } from './mark'
import { parse } from './markdown'
import { boxArt, mermaidText } from './mermaid'
import type { OpenTarget } from './paths'
import { editorUrl, makeLinker, makeResolver, parseOpenKey } from './paths'
import type { Controls, CopyButton, Drawn } from './render'
import { COPY, remember, renderBlocks, renderExpandedShell, renderOpenRow, renderToolGroup, renderToolRow, renderTurnDuration, width } from './render'
import { helpText, rtlShowcaseText, showcaseText } from './help'
import { PRESET_NAMES } from './presets'
import { nextSort } from './table'
import type { Style } from './theme'
import { resolveStyle } from './theme'
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

const expandedCalls = new Set<string>()

/**
 * ファイルをエディタで開く。URL を macOS は open、それ以外は xdg-open に渡す。開けなければトーストで知らせる。
 * 全画面表示の端末ではリンク（OSC 8）のクリックが Mod に届かず開かないため、ボタンからこれを呼ぶ。
 */
const openInEditor = async ($: EngineInterface, style: Style, target: OpenTarget): Promise<void> => {
  const url = editorUrl(style.editor, style.editorUrlTemplate, target.abs, target.line, target.col)
  if (url === undefined) return
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

const makeCopy = ($: EngineInterface, el: ReturnType<EngineInterface['ui']['resolve']>, style: Style): CopyButton => {
  const { Button } = el
  return (text, key, label = COPY, done = 'コピーしました') =>
    style.copyButtons ? (
      <Button
        key={key}
        variant="primary"
        label={label}
        onPress={press => {
          const value = typeof text === 'function' ? text() : text
          $.ui.copy({ text: value, surface: press.surface })
            .then(r => $.ui.toast(r.isCopied ? done : `コピーできませんでした: ${r.reason}`))
            .catch(() => $.ui.toast('コピーできませんでした'))
        }}
      />
    ) : null
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
      const art = mermaidText(block.lines.join('\n'), style.mermaidAscii, columns)
      if (art !== null && art.split('\n').every(l => width(l) <= columns - 2)) drawn.set(i, { element: boxArt(el, style, art, `b${i}`), art })
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

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const style = resolveStyle(options)
  const where = { cwd: '', home: '' }
  // パスのリンク（OSC 8）は端末でだけ描く。デスクトップなどは https 以外のリンクを描かないため。
  const terminalStyle: Style = { ...style, fileLinks: makeLinker(style.editor, style.editorUrlTemplate, where), fileTargets: makeResolver(style.editor, style.editorUrlTemplate, where) }
  const styles = [style, terminalStyle] as const
  const styleFor = (surface: string): Style => (surface === 'terminal' ? terminalStyle : style)
  const parsed = new Map<string, ReturnType<typeof parse>>()
  const parseCached = (text: string) => remember(parsed, text, () => parse(text, { numbers: style.highlightNumbers, paths: style.highlightPaths }))

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
    await applyRtl($, styles)
    await learnWhere($, where)
    const started = await next(e)
    await $.command
      .register({ name: 'reply-prism', description: 'reply-prism のテーマを切り替える・一覧を出す', argumentHint: '[theme <name> | demo]' })
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

  // 押して開くボタン（ツール行のパスと、返事の最後の「開く:」の行）。開く対象は key から戻す。
  // 他のボタン（コピー・開閉・並べ替え）は onPress で動くので、そのまま下へ流す。
  on('ui.press', async ($, e, next) => {
    const target = e.plugin === $.plugin.name ? parseOpenKey(e.element) : undefined
    if (target) await openInEditor($, style, target)
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
    const s = styleFor(e.surface)
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const controls = await readControls($, e, blocks)
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={s.theme.accent}>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          {drawMarkdown($, el, s, blocks, columns, controls)}
          {renderOpenRow(el, s, blocks)}
        </Box>
      </Box>
    )
  })
}
