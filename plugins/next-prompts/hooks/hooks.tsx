/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// エンジンは JSX を大域の `h` で組む。上のプラグマは、tsconfig を読まない場所から
// `bun test` したときも同じ組み方にするためのもの。
import type { EngineInterface, Register } from 'claude-code'

import {
  HEADING,
  GAP,
  lastUserText,
  layoutLabels,
  mergeCandidates,
  normalize,
  parseCandidates,
  promptOf,
  systemOf,
  transcriptOf,
} from './candidates'
import type { Message } from './candidates'
import { BAND_ORDER, BAND_STACK, slotKey, stackBand } from './band'

/** プラグイン名。ui.press の持ち主。 */
const PLUGIN = 'next-prompts'

/** 候補ボタンの key の頭（後ろに位置の番号を付ける）。 */
export const BUTTON_PREFIX = 'next-prompt-'

/** モデルの返事の上限トークン。候補 6 つ × 40 文字でも十分に収まる。 */
const MAX_TOKENS = 512

/** 候補づくりにかけてよい時間。過ぎたら諦めて何も出さない。 */
const TIMEOUT_MS = 20_000

/** 打ちかけの文があるとき、2 回目の押し込みを待つ時間。 */
export const CONFIRM_MS = 5_000

/** 帯の状態。描き直しのたびに読む（モジュール変数: 読み込み直しで消えてよい一時的なもの）。 */
type View = {
  /** idle: 何も出さない / thinking: 考え中 / ready: 出来た（空なら出さない）。 */
  phase: 'idle' | 'thinking' | 'ready'
  /** モデルが作った候補。 */
  generated: string[]
  /** 標準の提案（`prompt.suggest` の origin `suggestion`）。 */
  suggestion: string | null
  /** 送信済みの直前の依頼。 */
  lastPrompt: string
  /** 最後に描いた候補（押されたときはこれを引く）。 */
  shown: string[]
  /** 打ちかけの文があって 1 回目を受けたボタン。 */
  armed: { element: string; until: number } | null
  /** メインのターンが走っているか。 */
  isRunning: boolean
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function countOf(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 4

  return Math.max(3, Math.min(6, n))
}

function modelOf(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'haiku'
}

/** 描き直しを頼む。 */
function redraw($: EngineInterface): void {
  $.ui.invalidate('ui.render')
}

/**
 * 会話を読んでモデルに候補を作らせ、`view` に入れる。失敗したら何も出さない（例外も外へ出さない）。
 * `token` が `generation()` と違えば、そのあいだに次のターンが始まったので結果を捨てる。
 */
async function generate(
  $: EngineInterface,
  view: View,
  token: number,
  generation: () => number,
  settings: { count: number; model: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    // 帯を描く端末が無い（-p や SDK）なら作らない。
    const surfaces = await $.session.surfaces()

    if (!surfaces.includes('terminal') || token !== generation()) return

    view.phase = 'thinking'
    view.generated = []
    redraw($)

    const messages = (await $.session.messages()) as readonly Message[]
    const transcript = transcriptOf(messages)
    const last = lastUserText(messages) || view.lastPrompt

    if (transcript === '') {
      if (token === generation()) view.phase = 'idle'

      return
    }

    const reply = await $.model.complete(
      {
        model: settings.model,
        system: systemOf(settings.count),
        prompt: promptOf(transcript, last, settings.count),
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
      },
      { signal },
    )

    if (token !== generation()) return

    view.lastPrompt = last
    view.generated = reply.isAnswered ? parseCandidates(reply.text, settings.count, [last]) : []
    view.phase = 'ready'
  } catch {
    if (token === generation()) {
      view.generated = []
      view.phase = 'ready'
    }
  } finally {
    if (token === generation()) redraw($)
  }
}

/** 候補を入力欄に入れる。打ちかけの文があれば、同じボタンの 2 回目で置き換える。 */
async function choose($: EngineInterface, view: View, element: string): Promise<void> {
  const index = Number(element.slice(BUTTON_PREFIX.length))
  const text = view.shown[index]

  if (text === undefined) return

  const draft = normalize((await $.prompt.read()).text)
  // 空か、候補を入れたまま手を入れていなければ、そのまま差し替える。
  const isOwnDraft = draft !== '' && !view.shown.includes(draft) && draft !== view.suggestion

  if (isOwnDraft) {
    const now = await $.clock.now()

    if (view.armed === null || view.armed.element !== element || now > view.armed.until) {
      view.armed = { element, until: now + CONFIRM_MS }
      $.ui.toast('入力中の文があります。もう一度押すと置き換えます', { timeoutMs: CONFIRM_MS })

      return
    }
  }

  view.armed = null
  await $.prompt.fill({ text, mode: 'replace' })
}

/**
 * @param options manifest の `userConfig` の値
 */
export const register: Register = (on, options) => {
  const isEnabled = booleanOf(options['enabled'], true)
  const settings = { count: countOf(options['count']), model: modelOf(options['model']) }
  const view: View = {
    phase: 'idle',
    generated: [],
    suggestion: null,
    lastPrompt: '',
    shown: [],
    armed: null,
    isRunning: false,
  }
  let generation = 0
  let stop: AbortController | null = null

  /** 候補を消し、作りかけを止める。 */
  const reset = (): void => {
    generation += 1
    stop?.abort()
    stop = null
    view.phase = 'idle'
    view.generated = []
    view.suggestion = null
    view.shown = []
    view.armed = null
  }

  // 次のターンが始まったら候補を消す。
  on('turn.start', ($, e, next) => {
    reset()
    view.isRunning = true
    view.lastPrompt = normalize(e.text)
    redraw($)

    return next(e)
  })

  // メインループのターンが終わったら候補を作る（待たない）。
  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    view.isRunning = false

    if (isEnabled && e.reason === 'answer') {
      generation += 1
      stop?.abort()
      stop = new AbortController()

      const token = generation

      void generate($, view, token, () => generation, settings, stop.signal)
    }

    return next(e)
  })

  // 標準の提案も候補の先頭に足す（薄字の提案そのものはそのまま出す）。
  on('prompt.suggest', ($, e, next) => {
    if (isEnabled && e.origin.kind === 'suggestion' && !view.isRunning) {
      const text = normalize(e.text)

      view.suggestion = text === '' ? null : text
      redraw($)
    }

    return next(e)
  })

  // /clear で会話が変わったら消す。
  on('session.end', ($, e, next) => {
    reset()
    redraw($)

    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin === PLUGIN && e.component === 'AbovePrompt' && e.element.startsWith(BUTTON_PREFIX)) {
      await choose($, view, e.element)
    }

    return next(e)
  })

  // 帯: 他のプラグインの描画は先に受け取り、並び順（band.ts）どおりに積み直す。候補の行はいちばん下。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)

    if (!isEnabled || e.surface !== 'terminal' || e.props.hasSurvey || e.props.maxRows < 2) {
      view.shown = []

      return beneath
    }

    // ターン中と候補が無いときも、行そのものは残して薄字だけにする。
    // この行が出たり消えたりすると、上に並ぶ切り替えボタンの位置が動いてしまうため。
    const isThinking = view.phase === 'thinking'
    const candidates = e.props.isWorking
      ? []
      : mergeCandidates(view.suggestion, view.generated, settings.count, view.lastPrompt)
    const placed = layoutLabels(candidates, Math.max(20, e.props.bodyColumns))
    const idle = e.props.isWorking ? '（作業中）' : isThinking ? '候補を考え中…' : candidates.length === 0 ? '—' : ''

    view.shown = candidates

    const { Box, Text, Button } = $.ui.resolve(e)
    const row = (
      <Box key={slotKey(BAND_ORDER.nextPrompts, 'next-prompts')} flexDirection="row" flexWrap="wrap" columnGap={GAP}>
        <Text dimColor>{HEADING}</Text>
        {placed.map(item => (
          <Button key={`${BUTTON_PREFIX}${item.index}`} label={item.label} onPress={() => undefined} />
        ))}
        {idle === '' ? null : <Text dimColor>{idle}</Text>}
      </Box>
    )

    // 入力バーのすぐ上（帯のいちばん下）に置く。どのプラグインが外側でも並びは band.ts の順になる。
    return (
      <Box key={BAND_STACK} flexDirection="column">
        {stackBand(beneath, [row])}
      </Box>
    )
  })
}
