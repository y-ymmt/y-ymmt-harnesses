// 本家 prismantis の hooks/theme.ts を元にした改変版。reply-prism の設定（エディタ・危ない語と Claude の注意箇所・折りたたみ・表の並べ替えとコピー形式）を足している。
import type { PluginOptions } from 'claude-code'

import type { DangerMatchers } from './danger'
import { DEFAULT_DANGER_WORDS, buildDanger, parseWords } from './danger'
import type { Editor, Linker, Resolver } from './paths'
import { EDITORS } from './paths'
import { PRESETS } from './presets'
import type { ReplyFormat } from './reply'
import { REPLY_FORMATS } from './reply'
import type { CopyFormat } from './table'
import { COPY_FORMATS } from './table'
import type { Shape, Terminal } from './rtl'
import { TERMINALS } from './rtl'

export const TOKENS = [
  'accent', 'heading', 'strong', 'emphasis', 'inlineCode', 'codeText', 'codeCommand', 'codeFlag', 'codeString', 'codeComment',
  'link', 'path', 'number', 'quote', 'rule', 'tableHeader', 'tableRule', 'bullet', 'diagram', 'diagramText',
] as const

export type Theme = Partial<Record<(typeof TOKENS)[number], string>>

export type Style = {
  theme: Theme
  headingStyle: 'bold' | 'underline' | 'uppercase' | 'banner'
  tableStyle: 'rules' | 'grid' | 'minimal'
  highlightNumbers: boolean
  highlightPaths: boolean
  mermaid: boolean
  mermaidAscii: boolean
  copyButtons: boolean
  diagramHints: boolean
  rtl: 'auto' | Terminal | 'off'
  reorder: boolean
  shape: Shape
  // ---- ここから reply-prism で足したもの ----
  /** パスを開くエディタ。`editorUrlTemplate` があればそちらが優先。 */
  editor: Editor
  editorUrlTemplate: string
  /** 表示中のパス → URL。端末で描くときだけ register.tsx が入れる（他の面では null）。 */
  fileLinks: Linker | null
  /** 表示中のパス → 開く対象（押して開くボタン用）。端末で描くときだけ register.tsx が入れる（他の面では null）。 */
  fileTargets: Resolver | null
  /** 返事の最後に「開く:」とパスのボタンの行を足すか。足すときの数の上限。 */
  openRow: boolean
  openRowMax: number
  /**
   * reply-prism: 表を Claude Code 標準の Markdown で描くか。デスクトップアプリなど、文字ごとに幅の違うフォントで描く表示面では、
   * 文字数で列の幅と罫線を決める描き方だと罫線がずれ、表が横にはみ出すため。register.tsx が端末以外で true にする。
   */
  nativeTables?: boolean
  /** 「開く:」の行に URL のボタンを出したリンクの番号（URL → 番号）。本文のリンクの後ろに `[番号]` を付けるのに使う。register.tsx が返事ごとに入れる。 */
  linkNumbers?: ReadonlyMap<string, number>
  /** 危ない語。`dangerHighlight` が false なら null。 */
  danger: DangerMatchers | null
  dangerColor?: string
  dangerBackground?: string
  /** Claude が `==…==` で囲んだ箇所を危ない語と同じ見た目で描くか（`dangerHighlight`）。false でも印の記号は描かない。 */
  marks: boolean
  /** プロンプトに「注意すべき箇所を `==…==` で囲む」注記を添えるか。`dangerHighlight` がオフなら添えない。 */
  dangerHints: boolean
  /** これより行数の多い表・コードは畳む（0 で畳まない）。畳んだときは先頭 `preview` 行だけ見せる。 */
  fold: { threshold: number; preview: number }
  tableSort: boolean
  tableCopyFormats: CopyFormat[]
  /** 返事の最後に「コピー:」と形式ごとのボタンの行を足すか。並べる形式（並びもこのとおり）。 */
  replyCopy: boolean
  replyCopyFormats: ReplyFormat[]
}

const DEFAULT_DANGER_COLOR = '#ffffff'
const DEFAULT_DANGER_BACKGROUND = '#d20f39'

const int = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

/** `markdown,tsv,slack` → 並びどおりの形式。知らない名前は捨て、空なら全部。 */
const copyFormats = (value: unknown): CopyFormat[] => {
  const picked = parseWords(typeof value === 'string' ? value.toLowerCase() : value).filter((f): f is CopyFormat => (COPY_FORMATS as readonly string[]).includes(f))
  return picked.length ? [...new Set(picked)] : [...COPY_FORMATS]
}

/** `markdown,github,slack,notion` → 並びどおりの形式。知らない名前は捨て、空なら全部。 */
const replyFormats = (value: unknown): ReplyFormat[] => {
  const picked = parseWords(typeof value === 'string' ? value.toLowerCase() : value).filter((f): f is ReplyFormat => (REPLY_FORMATS as readonly string[]).includes(f))
  return picked.length ? [...new Set(picked)] : [...REPLY_FORMATS]
}

/** 危ない語の一覧。`dangerWords` が空でなければ既定を置き換え、`dangerWordsExtra` は足す。 */
export const dangerWords = (options: PluginOptions): string[] => {
  const own = parseWords(options.dangerWords)
  return [...(own.length ? own : DEFAULT_DANGER_WORDS), ...parseWords(options.dangerWordsExtra)]
}

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|ansi256\(\d{1,3}\)|(black|red|green|yellow|blue|magenta|cyan|white|gray|grey)(Bright)?)$/i

export const isColor = (value: unknown): value is string => typeof value === 'string' && COLOR.test(value.trim())

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

/** 配色の名前と、色ごとの上書き（`<token>Color`）から、描くときの配色を作る。知らない名前は catppuccin-mocha。 */
const themeOf = (name: unknown, options: PluginOptions): Theme => {
  const base: Theme = (PRESETS as Record<string, Theme>)[String(name)] ?? PRESETS['catppuccin-mocha']
  const fromFields = Object.fromEntries(
    TOKENS.filter(k => isColor(options[`${k}Color`])).map(k => [k, String(options[`${k}Color`]).trim()]),
  )
  return { ...base, ...fromFields }
}

/** reply-prism: デスクトップアプリで描くときの配色の名前（`desktopTheme`）。既定は明るい背景向けの github-light。`same` なら `theme` と同じ。 */
export const DEFAULT_DESKTOP_THEME = 'github-light'
const desktopThemeName = (options: PluginOptions): unknown =>
  options.desktopTheme === 'same'
    ? options.theme
    : typeof options.desktopTheme === 'string' && options.desktopTheme in PRESETS
      ? options.desktopTheme
      : DEFAULT_DESKTOP_THEME

/**
 * reply-prism: デスクトップアプリ（端末以外）で描くときの配色。デスクトップは白地のことが多く、
 * 端末用の暗い背景向けの配色（tokyo-night など）だと文字が淡くて読めないため、別に選べるようにする。
 */
export const desktopThemeOf = (options: PluginOptions): Theme => themeOf(desktopThemeName(options), options)

export const resolveStyle = (options: PluginOptions): Style => {

  const rtl = pick(options.rtl, ['auto', 'off', ...(Object.keys(TERMINALS) as Terminal[])], 'auto')

  const isMono = String(options.theme) === 'mono'
  const words = dangerWords(options)
  const fold = int(options.foldLines, 40, 0, 100000)

  return {
    editor: pick(options.editor, EDITORS, 'vscode'),
    editorUrlTemplate: typeof options.editorUrlTemplate === 'string' ? options.editorUrlTemplate.trim() : '',
    fileLinks: null,
    fileTargets: null,
    openRow: options.openRow !== false,
    openRowMax: int(options.openRowMax, 8, 1, 100),
    danger: options.dangerHighlight === false || words.length === 0 ? null : buildDanger(words),
    marks: options.dangerHighlight !== false,
    dangerHints: options.dangerHints !== false && options.dangerHighlight !== false,
    ...(isColor(options.dangerColor) ? { dangerColor: String(options.dangerColor).trim() } : isMono ? {} : { dangerColor: DEFAULT_DANGER_COLOR }),
    ...(isColor(options.dangerBackgroundColor) ? { dangerBackground: String(options.dangerBackgroundColor).trim() } : isMono ? {} : { dangerBackground: DEFAULT_DANGER_BACKGROUND }),
    fold: { threshold: fold, preview: Math.min(int(options.foldPreviewLines, 15, 1, 100000), fold || Infinity) },
    tableSort: options.tableSort !== false,
    tableCopyFormats: copyFormats(options.tableCopyFormats),
    replyCopy: options.replyCopy !== false,
    replyCopyFormats: replyFormats(options.replyCopyFormats),
    theme: themeOf(options.theme, options),
    headingStyle: pick(options.headingStyle, ['bold', 'underline', 'uppercase', 'banner'] as const, 'banner'),
    tableStyle: pick(options.tableStyle, ['rules', 'grid', 'minimal'] as const, 'rules'),
    highlightNumbers: options.highlightNumbers !== false,
    highlightPaths: options.highlightPaths !== false,
    mermaid: options.mermaid !== false,
    mermaidAscii: options.mermaidAscii === true,
    copyButtons: options.copyButtons !== false,
    diagramHints: options.diagramHints !== false && options.mermaid !== false,
    rtl,
    reorder: rtl !== 'auto' && rtl !== 'off',
    shape: rtl === 'auto' || rtl === 'off' ? 'visual' : TERMINALS[rtl],
  }
}
