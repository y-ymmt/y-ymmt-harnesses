/**
 * reply-prism が `$.state` に置く値の型（この Mod の契約）。
 *
 * hooks から `import type { ... } from '../types'` で読む。
 */

/** 1 つの表・コードブロックの表示状態。 */
export type ReplyPrismBlockView = {
  /** 長いブロックを開いているか（既定は畳んだまま）。 */
  open?: boolean
  /** 表を並べ替えている列（0 始まり）。 */
  sortCol?: number
  /** 並べ替えの向き。無ければ元の順。 */
  sortDir?: 'asc' | 'desc'
}

/** 1 つのメッセージの中のブロックの状態。キーはブロックの位置と中身から作る。 */
export type ReplyPrismView = { [blockId: string]: ReplyPrismBlockView }

/**
 * メインのターンが走っているか（返事まるごとコピーの行を、返事が終わってから最後のテキストブロックの下に出すため）。
 * ターンの始めと終わりに書く。会話の最後の返事のブロックだけが読み、書かれると描き直される。
 */
export type ReplyPrismTurn = {
  /** メインのターンが走っている間 true。 */
  running: boolean
  /** 書くたびに 1 増やす（同じ値の書き込みでも描き直させるため）。 */
  n: number
}

declare module 'claude-code' {
  interface PluginState {
    'reply-prism': {
      /** メッセージ（`ui.render` の requestId）ごとの表示状態。 */
      view: StateFamily<ReplyPrismView>
      /** メインのターンの状態（返事まるごとコピー）。 */
      turn: ReplyPrismTurn
    }
  }
}
