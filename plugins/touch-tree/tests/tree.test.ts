/**
 * ツリーの組み立てと幅合わせ（hooks/tree.ts）のテスト。`bun test plugins/touch-tree/tests/` で走る。
 */
import { describe, expect, test } from 'bun:test'

import { applyTouches, emptyRecord } from '../hooks/record'
import type { Touching } from '../hooks/record'
import {
  EXTERNAL_LABEL,
  fileMeta,
  fitRow,
  forestOf,
  rowsOf,
  textWidth,
  truncateMiddle,
  truncateStart,
} from '../hooks/tree'
import type { Row } from '../hooks/tree'

const ROOT = '/work/example-app'
const HOME = '/Users/me'
const JAVA = `${ROOT}/src/main/java/com/example/app`

const recordOf = (touches: Touching[]) => applyTouches(emptyRecord(ROOT, '', HOME), touches)

/** 罫線と名前と補足を 1 行の文字にしたもの。 */
const lineOf = (row: Row): string => `${row.guide}${row.name}${row.meta === '' ? '' : `  ${row.meta}`}`

describe('ツリーの組み立て', () => {
  test('共通の祖先（1 つしか子の無いディレクトリの連なり）は 1 行にまとめる', () => {
    const record = recordOf([
      { path: `${JAVA}/batch/FN27901.java`, read: { whole: true, lines: 120 } },
      { path: `${JAVA}/batch/FN22701.java`, read: { from: 1, to: 80, lines: 400, whole: false } },
      { path: `${JAVA}/web/ApiController.java`, edit: true },
    ])
    const rows = rowsOf(forestOf(record, true), record.last)

    expect(rows.map(lineOf)).toEqual([
      'example-app/  3 ✎1',
      '└ src/main/java/com/example/app/  3 ✎1',
      '  ├ batch/  2',
      '  │ ├ FN22701.java  1-80/400',
      '  │ └ FN27901.java  全120行',
      '  └ web/  1 ✎1',
      '    └ ApiController.java  ✎1',
    ])
  })

  test('ディレクトリには配下（孫以下も）の件数、ファイルが先に来ないこと（ディレクトリ→ファイルの順）', () => {
    const record = recordOf([
      { path: `${ROOT}/pom.xml`, read: { whole: true } },
      { path: `${ROOT}/src/a/A.java`, read: { whole: true } },
      { path: `${ROOT}/src/a/deep/B.java`, read: { whole: true } },
      { path: `${ROOT}/src/b/C.java`, create: true },
    ])
    const rows = rowsOf(forestOf(record, true), record.last)

    expect(rows.map(lineOf)).toEqual([
      'example-app/  4 ✎1',
      '├ src/  3 ✎1',
      '│ ├ a/  2',
      '│ │ ├ deep/  1',
      '│ │ │ └ B.java  全体',
      '│ │ └ A.java  全体',
      '│ └ b/  1 ✎1',
      '│   └ C.java  新規',
      '└ pom.xml  全体',
    ])
  })

  test('リポジトリ外のファイルは (外部) の枝にまとめ、ホーム配下は ~ から出す', () => {
    const record = recordOf([
      { path: `${ROOT}/README.md`, read: { whole: true } },
      { path: `${HOME}/.claude/CLAUDE.md`, read: { whole: true } },
      { path: `${HOME}/.claude/projects/x/memory/MEMORY.md`, read: { whole: true } },
      { path: '/private/tmp/scratch/out.log', read: { from: 10, to: 20, whole: false } },
    ])
    const rows = rowsOf(forestOf(record, true), record.last)

    expect(rows.map(lineOf)).toEqual([
      'example-app/  1',
      '└ README.md  全体',
      `${EXTERNAL_LABEL}  3`,
      '├ /private/tmp/scratch/  1',
      '│ └ out.log  10-20',
      '└ ~/.claude/  2',
      '  ├ projects/x/memory/  1',
      '  │ └ MEMORY.md  全体',
      '  └ CLAUDE.md  全体',
    ])
  })

  test('ルートが分からなければ全部を外部として出す', () => {
    const record = applyTouches(emptyRecord('', '', HOME), [{ path: `${ROOT}/a.txt`, read: { whole: true } }])
    const forest = forestOf(record, true)

    expect(forest.repo).toBeNull()
    expect(forest.external?.count).toBe(1)
  })

  test('検索に出ただけのファイルは showHits=false で隠し、隠した数を返す', () => {
    const record = recordOf([
      { path: `${ROOT}/a/A.java`, read: { whole: true } },
      { path: `${ROOT}/a/B.java`, hit: true },
      { path: `${ROOT}/c/C.java`, hit: true },
    ])
    const hidden = forestOf(record, false)

    expect(hidden.hidden).toBe(2)
    expect(hidden.repo?.count).toBe(1)
    expect(rowsOf(hidden, null).map(lineOf)).toEqual(['example-app/  1', '└ a/  1', '  └ A.java  全体'])

    const shown = forestOf(record, true)

    expect(shown.hidden).toBe(0)
    expect(shown.repo?.count).toBe(3)
  })

  test('最後に触ったファイルに印が付く', () => {
    const record = recordOf([{ path: `${ROOT}/x.ts`, read: { whole: true } }])
    const rows = rowsOf(forestOf(record, true), record.last)

    expect(rows.find(r => r.kind === 'file')?.isLast).toBe(true)
  })
})

describe('ファイル行の補足', () => {
  test('状態ごとの書き方', () => {
    const base = { reads: 0, ranges: [] as [number, number][], whole: false, edits: 0, created: false, hits: 0, seq: 1 }

    expect(fileMeta({ ...base, created: true })).toBe('新規')
    expect(fileMeta({ ...base, created: true, edits: 2 })).toBe('新規 ✎2')
    expect(fileMeta({ ...base, edits: 3, reads: 1, whole: true, lines: 50 })).toBe('✎3 全50行')
    expect(fileMeta({ ...base, reads: 2, ranges: [[1, 80], [120, 160], [300, 310]], lines: 812 })).toBe('1-80,120-160 +1/812')
    expect(fileMeta({ ...base, reads: 1 })).toBe('一部')
    expect(fileMeta({ ...base, hits: 1 })).toBe('検索')
    expect(fileMeta({ ...base, hits: 4 })).toBe('検索×4')
  })
})

describe('幅合わせ', () => {
  const big = recordOf([
    { path: `${JAVA}/batch/fn27901/FaxOshiraseMailKanryoTorikomiService.java`, read: { from: 1, to: 300, lines: 1800, whole: false } },
    { path: `${JAVA}/batch/fn27901/dao/FaxOshiraseMailKanryoTorikomiDao.java`, edit: true },
    { path: `${JAVA}/batch/fn22701/日本語のファイル名_とても長い名前です.txt`, read: { whole: true, lines: 12 } },
    { path: `${JAVA}/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/Deep.java`, read: { whole: true } },
    { path: `${JAVA}/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/Other.java`, read: { whole: true } },
    { path: `${HOME}/.claude/projects/-Users-me-work-example-app/memory/MEMORY.md`, hit: true },
  ])
  const rows = rowsOf(forestOf(big, true), big.last)

  for (const columns of [12, 20, 32, 40, 66, 120]) {
    test(`${columns} 桁で全行が幅に収まり、名前が空にならない`, () => {
      for (const row of rows) {
        const fitted = fitRow(row, columns)
        const width = textWidth(fitted.guide) + textWidth(fitted.symbol) + textWidth(fitted.name) + (fitted.meta === '' ? 0 : 1 + textWidth(fitted.meta))

        expect(width).toBe(fitted.width)
        expect(fitted.width).toBeLessThanOrEqual(columns)
        expect(fitted.name.length).toBeGreaterThan(0)
      }
    })
  }

  test('広ければ何も切らない', () => {
    for (const row of rows) {
      const fitted = fitRow(row, 400)

      expect(fitted.name).toBe(row.name)
      expect(fitted.meta).toBe(row.meta)
      expect(fitted.guide).toBe(row.guide)
    }
  })

  test('ディレクトリは先頭を、ファイルは真ん中を切る', () => {
    expect(truncateStart('src/main/java/com/example/', 14)).toBe('…/com/example/')

    const cut = truncateMiddle('FaxOshiraseMailKanryoTorikomiService.java', 20)

    expect(textWidth(cut)).toBeLessThanOrEqual(20)
    expect(cut).toBe('FaxOshiras…vice.java')
    expect(cut.endsWith('.java')).toBe(true)
  })

  test('全角は 2 桁で数える', () => {
    expect(textWidth('日本語abc')).toBe(9)
    expect(textWidth(EXTERNAL_LABEL)).toBe(6)
  })
})
