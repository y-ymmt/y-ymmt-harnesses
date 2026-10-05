// 本家 prismantis の hooks/theme.ts を元にした改変版。reply-prism の設定（エディタ・危ない語・折りたたみ・表の並べ替えとコピー形式）を足している。
import type { PluginOptions } from 'claude-code'

import type { DangerMatchers } from './danger'
import { DEFAULT_DANGER_WORDS, buildDanger, parseWords } from './danger'
import type { Editor, Linker, Resolver } from './paths'
import { EDITORS } from './paths'
import { PRESETS } from './presets'
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
  /** 危ない語。`dangerHighlight` が false なら null。 */
  danger: DangerMatchers | null
  dangerColor?: string
  dangerBackground?: string
  /** これより行数の多い表・コードは畳む（0 で畳まない）。畳んだときは先頭 `preview` 行だけ見せる。 */
  fold: { threshold: number; preview: number }
  tableSort: boolean
  tableCopyFormats: CopyFormat[]
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

/** 危ない語の一覧。`dangerWords` が空でなければ既定を置き換え、`dangerWordsExtra` は足す。 */
export const dangerWords = (options: PluginOptions): string[] => {
  const own = parseWords(options.dangerWords)
  return [...(own.length ? own : DEFAULT_DANGER_WORDS), ...parseWords(options.dangerWordsExtra)]
}

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|ansi256\(\d{1,3}\)|(black|red|green|yellow|blue|magenta|cyan|white|gray|grey)(Bright)?)$/i

export const isColor = (value: unknown): value is string => typeof value === 'string' && COLOR.test(value.trim())

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

export const resolveStyle = (options: PluginOptions): Style => {
  const base: Theme = (PRESETS as Record<string, Theme>)[String(options.theme)] ?? PRESETS['catppuccin-mocha']
  const fromFields = Object.fromEntries(
    TOKENS.filter(k => isColor(options[`${k}Color`])).map(k => [k, String(options[`${k}Color`]).trim()]),
  )

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
    ...(isColor(options.dangerColor) ? { dangerColor: String(options.dangerColor).trim() } : isMono ? {} : { dangerColor: DEFAULT_DANGER_COLOR }),
    ...(isColor(options.dangerBackgroundColor) ? { dangerBackground: String(options.dangerBackgroundColor).trim() } : isMono ? {} : { dangerBackground: DEFAULT_DANGER_BACKGROUND }),
    fold: { threshold: fold, preview: Math.min(int(options.foldPreviewLines, 15, 1, 100000), fold || Infinity) },
    tableSort: options.tableSort !== false,
    tableCopyFormats: copyFormats(options.tableCopyFormats),
    theme: { ...base, ...fromFields },
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
