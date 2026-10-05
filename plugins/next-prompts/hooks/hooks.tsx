/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// エンジンは JSX を大域の `h` で組む。上のプラグマは、tsconfig を読まない場所から
// `bun test` したときも同じ組み方にするためのもの。
import type { EngineInterface, Register } from 'claude-code'

import {
  HEADING,
  GAP,
  fingerprintOf,
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

// ボタンの常時の背景。Button には背景色の指定が無い（文字のスタイルと hover だけ）ので Box で包んで塗る。
// Claude Code 本体のテーマの色なので、暗い背景でも明るい背景でも文字が読める。ホバーの反転とは別の層。
// ボタンの下地。テーマの userMessageBackground では薄くて見えなかったので、暗い背景で目立つ濃い灰青にする。
const CHIP_BACK = '#4b5470'

/** 候補ボタンの key の頭（後ろに位置の番号を付ける）。 */
export const BUTTON_PREFIX = 'next-prompt-'

/** モデルの返事の上限トークン。種類つきの候補 7 つ × 40 文字でも十分に収まる。 */
const MAX_TOKENS = 768

/** 保存した候補の置き場所（`$.store`）。 */
const SAVED_KEY = 'saved'

/** 保存しておく会話の数。古いものから捨てる。 */
const SAVED_LIMIT = 30

/** 保存した候補 1 つぶん。`fingerprint` は会話のいまの位置（`fingerprintOf`）。 */
type Saved = { fingerprint: string; generated: string[]; lastPrompt: string; at: number }

/** 考える深さ。候補づくりは軽い仕事なので浅くして速くする（対応しないモデルでは無視される）。 */
const EFFORT = 'low'

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
  /** 保存した候補を読み戻しにいったか（セッションの始まりに 1 回だけ）。 */
  isRestoreTried: boolean
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

function savedOf(value: unknown): Saved[] {
  if (!Array.isArray(value)) return []

  return value.filter(
    (item): item is Saved =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Saved).fingerprint === 'string' &&
      Array.isArray((item as Saved).generated) &&
      (item as Saved).generated.every(text => typeof text === 'string') &&
      typeof (item as Saved).lastPrompt === 'string',
  )
}

/** 作った候補を、その会話の位置と一緒に保存する（`claude -c` / `-r` で再開したときに出し直すため）。 */
async function save($: EngineInterface, fingerprint: string, generated: string[], lastPrompt: string): Promise<void> {
  try {
    const at = await $.clock.now()
    const kept = savedOf(await $.store.get(SAVED_KEY)).filter(item => item.fingerprint !== fingerprint)

    await $.store.set(SAVED_KEY, [{ fingerprint, generated, lastPrompt, at }, ...kept].slice(0, SAVED_LIMIT))
  } catch {
    // 保存できなくても候補は出ている。再開したときに出ないだけ。
  }
}

/**
 * 再開したセッションなら、最後に作った候補を読み戻す。会話のいまの位置と保存したときの位置が
 * 同じときだけ出す（続きの会話が進んでいたら古い候補なので出さない）。
 */
async function restore($: EngineInterface, view: View, token: number, generation: () => number): Promise<void> {
  try {
    const fingerprint = fingerprintOf((await $.session.messages()) as readonly Message[])

    if (fingerprint === null || token !== generation()) return

    const found = savedOf(await $.store.get(SAVED_KEY)).find(item => item.fingerprint === fingerprint)

    if (found === undefined || token !== generation() || view.phase !== 'idle' || view.isRunning) return

    view.generated = found.generated
    view.lastPrompt = found.lastPrompt
    view.phase = 'ready'
    redraw($)
  } catch {
    // 読めなければ出さない。
  }
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
    const fingerprint = fingerprintOf(messages)
    const transcript = transcriptOf(messages)
    const last = lastUserText(messages) || view.lastPrompt

    if (transcript === '') {
      if (token === generation()) view.phase = 'idle'

      return
    }

    const startedAt = await $.clock.now()
    const reply = await $.model.complete(
      {
        model: settings.model,
        effort: EFFORT,
        system: systemOf(settings.count),
        prompt: promptOf(transcript, last, settings.count),
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
      },
      { signal },
    )

    // かかった時間と量をデバッグログへ（`claude --debug-file` で見られる。トランスクリプトには出さない）。
    const elapsed = (await $.clock.now()) - startedAt
    const { input_tokens: input, output_tokens: output } = reply.usage

    $.ui.log(
      `${settings.model} effort=${EFFORT} ${elapsed}ms in=${input} out=${output} ` +
        (reply.isAnswered ? `answered ${reply.text.length}chars` : `no-text ${reply.reason}`),
      { to: 'debug' },
    )

    if (token !== generation()) return

    view.lastPrompt = last
    view.generated = reply.isAnswered ? parseCandidates(reply.text, settings.count, [last]) : []
    view.phase = 'ready'

    if (fingerprint !== null && view.generated.length > 0) void save($, fingerprint, view.generated, last)
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
 * 入力欄の全文が「/番号 + 空白」（半角・全角どちらでも。例 `/2 `、`／２　`）なら、その番号。違えば null。
 */
export function pickNumberOf(text: string): number | null {
  const match = /^[/／]([1-9１-９])[ 　]$/u.exec(text)

  return match === null ? null : Number((match[1] as string).normalize('NFKC'))
}

/**
 * @param options manifest の `userConfig` の値
 */
export const register: Register = (on, options) => {
  const isEnabled = booleanOf(options['enabled'], true)
  const settings = {
    count: countOf(options['count']),
    model: modelOf(options['model']),
    digitSelect: booleanOf(options['digitSelect'], true),
  }
  const view: View = {
    phase: 'idle',
    generated: [],
    suggestion: null,
    lastPrompt: '',
    shown: [],
    armed: null,
    isRunning: false,
    isRestoreTried: false,
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
    view.isRestoreTried = true
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

  // /clear で会話が変わったら消す。次の会話を再開（/resume）したら、その会話の候補を読み戻しにいく。
  on('session.end', ($, e, next) => {
    reset()
    view.isRestoreTried = false
    redraw($)

    return next(e)
  })

  // /1 + 空白で選ぶ: 空の入力欄が「/1 」になった瞬間に、その番号の候補の全文に置き換える。何も送らないので、
  // 会話の記録にもモデルへの会話にも残らない。数字だけの「1」は送れ、日本語入力の途中で置き換わることもない。
  on('prompt.edit', async ($, e, next) => {
    if (!isEnabled || !settings.digitSelect || view.isRunning || view.shown.length === 0) return next(e)

    const after = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    const n = pickNumberOf(after)
    const text = n === null ? undefined : view.shown[n - 1]

    if (text === undefined) return next(e)

    view.armed = null
    redraw($)

    return { text, cursor: text.length }
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

    // 再開したセッションの最初の描画で、保存しておいた候補を読み戻しにいく（待たない）。
    if (!view.isRestoreTried && view.phase === 'idle' && !view.isRunning && !e.props.isWorking) {
      view.isRestoreTried = true
      void restore($, view, generation, () => generation)
    }

    // ターン中と候補が無いときも、行そのものは残して薄字だけにする。
    // この行が出たり消えたりすると、上に並ぶ切り替えボタンの位置が動いてしまうため。
    const isThinking = view.phase === 'thinking'
    const candidates = e.props.isWorking
      ? []
      : mergeCandidates(view.suggestion, view.generated, settings.count, view.lastPrompt)
    const placed = layoutLabels(candidates, Math.max(20, e.props.bodyColumns), 2, settings.digitSelect)
    const idle = e.props.isWorking ? '（作業中）' : isThinking ? '候補を考え中…' : candidates.length === 0 ? '—' : ''

    view.shown = candidates

    const { Box, Text, Button } = $.ui.resolve(e)
    const row = (
      <Box key={slotKey(BAND_ORDER.nextPrompts, 'next-prompts')} flexDirection="row" flexWrap="wrap" columnGap={GAP}>
        <Text dimColor>{HEADING}</Text>
        {placed.map(item => (
          <Box key={`${BUTTON_PREFIX}${item.index}.chip`} flexShrink={0} backgroundColor={CHIP_BACK}>
            <Button
              key={`${BUTTON_PREFIX}${item.index}`}
              label={item.label}
              onPress={() => undefined}
            />
          </Box>
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
