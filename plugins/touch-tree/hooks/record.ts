/**
 * 触ったファイルの記録（純関数）。`$` には触らない。
 */
import type { TouchTreeRecord, TouchTreeTouch } from '../types'

/** ファイル 1 件の状態。左ほど深い（ツリーではいちばん深いものを出す）。 */
export type Kind = 'created' | 'edited' | 'read' | 'partial' | 'hit'

/** 1 回のツール呼び出しで分かった、1 ファイルぶんの触り方。 */
export type Touching = {
  /** 絶対パス（normalizePath 済み）。 */
  path: string
  /** 読んだ。from/to が無ければ範囲は不明。 */
  read?: { from?: number; to?: number; lines?: number; whole: boolean }
  /** 書き換えた（Edit・上書きの Write・NotebookEdit）。 */
  edit?: true
  /** 新しく作った（Write）。 */
  create?: true
  /** 検索や LSP の結果に出てきた。 */
  hit?: true
}

export const emptyRecord = (root = '', alias = '', home = ''): TouchTreeRecord => ({
  root,
  alias,
  home,
  files: {},
  seq: 0,
  last: null,
})

const emptyTouch = (): TouchTreeTouch => ({
  reads: 0,
  ranges: [],
  whole: false,
  edits: 0,
  created: false,
  hits: 0,
  seq: 0,
})

/**
 * 範囲を並べ、重なりと隣り合い（10-20 と 21-30）をまとめる。
 */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b >= a)
    .map(([a, b]) => [a, b] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: [number, number][] = []

  for (const [a, b] of sorted) {
    const last = out[out.length - 1]

    if (last !== undefined && a <= last[1] + 1) {
      last[1] = Math.max(last[1], b)
    } else {
      out.push([a, b])
    }
  }

  return out
}

/**
 * 範囲がファイル全体を覆っているか。末尾の改行で総行数が 1 行多く数えられることがあるので、
 * 最後の 1 行が欠けているだけなら全体とみなす。
 */
export function coversWhole(ranges: readonly (readonly [number, number])[], lines: number | undefined): boolean {
  if (lines === undefined || lines <= 0) {
    return false
  }

  const only = ranges.length === 1 ? ranges[0] : undefined

  return only !== undefined && only[0] <= 1 && only[1] >= lines - 1
}

/** 1 回の呼び出しの中で、同じファイルの触り方を 1 つにまとめる。 */
function combine(list: readonly Touching[]): Touching[] {
  const byPath = new Map<string, Touching>()

  for (const one of list) {
    const prev = byPath.get(one.path)

    if (prev === undefined) {
      byPath.set(one.path, { ...one })
      continue
    }

    if (one.read !== undefined) {
      prev.read = prev.read === undefined || one.read.whole ? one.read : prev.read
    }
    if (one.edit) prev.edit = true
    if (one.create) prev.create = true
    if (one.hit) prev.hit = true
  }

  return [...byPath.values()]
}

/**
 * 記録に触り方を足した新しい記録を返す（元の記録は変えない）。
 */
export function applyTouches(record: TouchTreeRecord, list: readonly Touching[]): TouchTreeRecord {
  if (list.length === 0) {
    return record
  }

  const files = { ...record.files }
  let seq = record.seq
  let last = record.last

  for (const one of combine(list)) {
    const prev = files[one.path] ?? emptyTouch()
    const next: TouchTreeTouch = { ...prev, ranges: prev.ranges.map(([a, b]) => [a, b] as [number, number]) }

    seq += 1
    next.seq = seq

    if (one.read !== undefined) {
      next.reads += 1

      if (one.read.lines !== undefined) {
        next.lines = one.read.lines
      }

      if (one.read.whole) {
        next.whole = true
      } else if (one.read.from !== undefined && one.read.to !== undefined) {
        next.ranges = mergeRanges([...next.ranges, [one.read.from, one.read.to]])

        if (coversWhole(next.ranges, next.lines)) {
          next.whole = true
        }
      }
    }

    if (one.create) {
      next.created = true
    } else if (one.edit) {
      next.edits += 1
    }

    if (one.hit) {
      next.hits += 1
    }

    files[one.path] = next

    // 検索に出ただけのものは「最後に触った」にしない（grep の出力で何百件も来るため）。
    if (one.read !== undefined || one.edit || one.create) {
      last = one.path
    }
  }

  return { ...record, files, seq, last }
}

/** ファイルのいちばん深い状態。 */
export function kindOf(touch: TouchTreeTouch): Kind {
  if (touch.created) return 'created'
  if (touch.edits > 0) return 'edited'
  if (touch.whole) return 'read'
  if (touch.reads > 0) return 'partial'

  return 'hit'
}

/**
 * パスを、`.`・`..`・連続する `/` の無い絶対パスにそろえる。
 *
 * @param raw ツールが受け取った（あるいは出力した）パス
 * @param base 相対パスの起点（絶対パス）。分からなければ空
 * @param home `~` を展開する先。分からなければ空
 * @returns 絶対パス。決められなければ undefined
 */
export function normalizePath(raw: string, base: string, home: string): string | undefined {
  const p = raw.trim()

  if (p === '' || p === '-' || p === '/dev/null' || p.includes('\0')) {
    return undefined
  }

  let joined: string

  if (p.startsWith('/')) {
    joined = p
  } else if (p === '~' || p.startsWith('~/')) {
    if (home === '') return undefined
    joined = home + p.slice(1)
  } else {
    if (!base.startsWith('/')) return undefined
    joined = `${base}/${p}`
  }

  const parts: string[] = []

  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return '/' + parts.join('/')
}

/**
 * root の別名（`/tmp` と `/private/tmp` のようなシンボリックリンク越しの綴り）で
 * 書かれたパスを、root の綴りに直す。
 */
export function canonical(path: string, root: string, alias: string): string {
  if (alias !== '' && root !== '' && (path === alias || path.startsWith(alias + '/'))) {
    return root + path.slice(alias.length)
  }

  return path
}

/**
 * Read の結果から、読んだ範囲を取り出す。
 *
 * テキストは `file.startLine`・`numLines`・`totalLines` で範囲が分かる。トークン上限で
 * 自動的に途中までに切られたものは部分読み。画像・PDF・ノートブックは全体とみなす。
 */
export function readOfResult(result: unknown): NonNullable<Touching['read']> {
  const value = result as
    | {
        type?: unknown
        file?: { startLine?: unknown; numLines?: unknown; totalLines?: unknown; truncatedByTokenCap?: unknown }
      }
    | undefined

  if (value === undefined || value === null || typeof value !== 'object') {
    return { whole: true }
  }

  if (value.type !== 'text') {
    return { whole: true }
  }

  const from = value.file?.startLine
  const count = value.file?.numLines
  const lines = value.file?.totalLines

  if (typeof from !== 'number' || typeof count !== 'number' || typeof lines !== 'number') {
    return { whole: true }
  }

  if (count <= 0) {
    // 空のファイル、または範囲が末尾より後ろ。
    return { lines, whole: lines === 0 }
  }

  const to = from + count - 1
  const whole = value.file?.truncatedByTokenCap !== true && coversWhole([[from, to]], lines)

  return { from, to, lines, whole }
}

/**
 * 記録の件数を状態ごとに数える（帯や見出しの要約用）。
 */
export function countKinds(files: TouchTreeRecord['files']): Record<Kind, number> {
  const counts: Record<Kind, number> = { created: 0, edited: 0, read: 0, partial: 0, hit: 0 }

  for (const touch of Object.values(files)) {
    counts[kindOf(touch)] += 1
  }

  return counts
}
