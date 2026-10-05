/**
 * touch-tree が `$.state` に置く値の型（この Mod の契約）。
 *
 * hooks から `import type { ... } from '../types'` で読む。
 */

/**
 * 1 ファイルぶんの記録。キーは正規化した絶対パス。
 */
export type TouchTreeTouch = {
  /** Read（や cat・head など）で開いた回数。 */
  reads: number
  /** 読んだ行の範囲。1 始まり・両端を含み、重なりと隣り合いはまとめてある。 */
  ranges: [number, number][]
  /** ファイルの総行数。Read の結果で分かったときだけ。 */
  lines?: number
  /** ファイル全体を読んだか（範囲を重ねて全体になった場合も含む）。 */
  whole: boolean
  /** Edit・Write（上書き）・NotebookEdit の回数。新規作成の 1 回は含まない。 */
  edits: number
  /** Write で新しく作ったか。 */
  created: boolean
  /** 検索（Grep・Glob・grep・find）や LSP の結果に出てきた回数。 */
  hits: number
  /** 最後に触った順番（大きいほど新しい）。 */
  seq: number
}

/**
 * このセッションの記録。
 */
export type TouchTreeRecord = {
  /** ツールの根にするリポジトリのルート（作業ディレクトリの git ルート）。分からなければ空。 */
  root: string
  /** root を別名（シンボリックリンク越し）で書いたときの綴り。無ければ空。 */
  alias: string
  /** ホームディレクトリ。外部ファイルを `~/` で短く出すのに使う。 */
  home: string
  /** 触ったファイル。キーは絶対パス。 */
  files: { [path: string]: TouchTreeTouch }
  /** 触った回数の通し番号。 */
  seq: number
  /** 最後に触ったファイル。 */
  last: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'touch-tree': {
      record: TouchTreeRecord
      /** 検索・LSP に出てきただけのファイルもツリーに出すか。 */
      showHits: boolean
    }
  }
}
