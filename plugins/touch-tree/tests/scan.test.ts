/**
 * 記録（hooks/record.ts）と、ツールの入出力からの拾い方（hooks/scan.ts）のテスト。
 */
import { describe, expect, test } from 'bun:test'

import { applyTouches, canonical, coversWhole, emptyRecord, kindOf, mergeRanges, normalizePath, readOfResult } from '../hooks/record'
import { lspCandidates, outputCandidates, pathsOfLine, planBash, searchToolCandidates, segmentsOf } from '../hooks/scan'

const ROOT = '/work/repo'
const HOME = '/Users/me'

describe('読んだ範囲の合算', () => {
  test('重なりと隣り合いをまとめ、並べ替える', () => {
    expect(mergeRanges([[50, 60], [1, 10], [11, 20], [15, 30], [100, 100]])).toEqual([[1, 30], [50, 60], [100, 100]])
    expect(mergeRanges([[5, 3], [0, 2]])).toEqual([])
  })

  test('範囲を重ねて全体になったら「全体」に上がる（末尾の 1 行欠けは全体とみなす）', () => {
    let record = emptyRecord(ROOT, '', HOME)
    const path = `${ROOT}/A.java`

    record = applyTouches(record, [{ path, read: { from: 1, to: 100, lines: 250, whole: false } }])
    expect(kindOf(record.files[path]!)).toBe('partial')
    expect(record.files[path]!.ranges).toEqual([[1, 100]])

    record = applyTouches(record, [{ path, read: { from: 201, to: 249, lines: 250, whole: false } }])
    expect(record.files[path]!.ranges).toEqual([[1, 100], [201, 249]])
    expect(record.files[path]!.whole).toBe(false)

    record = applyTouches(record, [{ path, read: { from: 90, to: 210, lines: 250, whole: false } }])
    expect(record.files[path]!.ranges).toEqual([[1, 249]])
    expect(record.files[path]!.whole).toBe(true)
    expect(record.files[path]!.reads).toBe(3)
    expect(kindOf(record.files[path]!)).toBe('read')
    expect(coversWhole([[1, 249]], 250)).toBe(true)
    expect(coversWhole([[1, 248]], 250)).toBe(false)
  })

  test('状態はいちばん深いもの。新規作成は edits に数えない', () => {
    let record = emptyRecord(ROOT, '', HOME)
    const path = `${ROOT}/New.java`

    record = applyTouches(record, [{ path, hit: true }])
    expect(kindOf(record.files[path]!)).toBe('hit')
    expect(record.last).toBeNull()

    record = applyTouches(record, [{ path, create: true }])
    record = applyTouches(record, [{ path, edit: true }])
    expect(record.files[path]).toMatchObject({ created: true, edits: 1, hits: 1 })
    expect(kindOf(record.files[path]!)).toBe('created')
    expect(record.last).toBe(path)
  })

  test('元の記録は変えない', () => {
    const before = applyTouches(emptyRecord(ROOT, '', HOME), [{ path: `${ROOT}/a`, read: { from: 1, to: 2, whole: false } }])
    const frozen = JSON.stringify(before)

    applyTouches(before, [{ path: `${ROOT}/a`, read: { from: 3, to: 9, whole: false } }])
    expect(JSON.stringify(before)).toBe(frozen)
  })

  test('Read の結果から範囲を読む', () => {
    const text = (startLine: number, numLines: number, totalLines: number, truncatedByTokenCap?: boolean) => ({
      type: 'text',
      file: { filePath: '/x', content: '', startLine, numLines, totalLines, ...(truncatedByTokenCap ? { truncatedByTokenCap } : {}) },
    })

    expect(readOfResult(text(1, 200, 200))).toEqual({ from: 1, to: 200, lines: 200, whole: true })
    expect(readOfResult(text(101, 50, 400))).toEqual({ from: 101, to: 150, lines: 400, whole: false })
    expect(readOfResult(text(1, 2000, 2000, true)).whole).toBe(false)
    expect(readOfResult({ type: 'image', file: {} })).toEqual({ whole: true })
    expect(readOfResult(undefined)).toEqual({ whole: true })
  })
})

describe('パスの正規化', () => {
  test('相対・~・.. を解く', () => {
    expect(normalizePath('src/../src/./A.java', ROOT, HOME)).toBe(`${ROOT}/src/A.java`)
    expect(normalizePath('~/.claude/CLAUDE.md', ROOT, HOME)).toBe(`${HOME}/.claude/CLAUDE.md`)
    expect(normalizePath('//a//b/', ROOT, HOME)).toBe('/a/b')
    expect(normalizePath('rel', '', HOME)).toBeUndefined()
    expect(normalizePath('/dev/null', ROOT, HOME)).toBeUndefined()
  })

  test('ルートの別名（リンク越しの綴り）を直す', () => {
    expect(canonical('/tmp/repo/a.ts', '/private/tmp/repo', '/tmp/repo')).toBe('/private/tmp/repo/a.ts')
    expect(canonical('/tmp/other/a.ts', '/private/tmp/repo', '/tmp/repo')).toBe('/tmp/other/a.ts')
  })
})

describe('Bash の見立て', () => {
  test('語と区切りに分ける（引用符・2>&1）', () => {
    expect(segmentsOf(`grep -rn "a | b" src 2>&1 | head -20 && cat 'x y.txt'`)).toEqual([
      ['grep', '-rn', 'a | b', 'src', '2>&1'],
      ['head', '-20'],
      ['cat', 'x y.txt'],
    ])
  })

  test('cat・head・sed -n・tail を読んだとみなし、範囲が分かれば取る', () => {
    const plan = planBash(
      `cat pom.xml && head -n 30 src/A.java; sed -n '120,180p' src/B.java | nl; tail -50 log.txt; head -5 C.java`,
      ROOT,
      HOME,
    )

    expect(plan.reads).toEqual([
      { path: `${ROOT}/pom.xml`, whole: true },
      { path: `${ROOT}/src/A.java`, from: 1, to: 30, whole: false },
      { path: `${ROOT}/src/B.java`, from: 120, to: 180, whole: false },
      { path: `${ROOT}/log.txt`, whole: false },
      { path: `${ROOT}/C.java`, from: 1, to: 5, whole: false },
    ])
    expect(plan.scanBase).toBeNull()
  })

  test('cd を追い、以降の相対パスはその先から解く', () => {
    const plan = planBash('cd sub/dir && cat ../x.md && cd $SOMEWHERE && cat y.md', ROOT, HOME)

    expect(plan.reads).toEqual([{ path: `${ROOT}/sub/x.md`, whole: true }])
  })

  test('sed -i は読み取りに数えない。ヒアドキュメントの本文やリダイレクト先も拾わない', () => {
    const plan = planBash(`sed -i '' 's/a/b/' A.java\ncat > out.txt <<'EOF'\ncat secret.txt\nEOF\nwc -l < in.txt`, ROOT, HOME)

    expect(plan.reads).toEqual([])
  })

  test('grep 系は出力を読む起点と、名指しのファイルを返す（パターンや -e の値は捨てる側で確かめる）', () => {
    const plan = planBash('cd src && grep -rn -e foo main/A.java main/B.java | head', ROOT, HOME)

    expect(plan.scanBase).toBe(`${ROOT}/src`)
    expect(plan.named).toEqual([`${ROOT}/src/main/A.java`, `${ROOT}/src/main/B.java`])
    expect(planBash('git grep -n Foo -- src', ROOT, HOME).scanBase).toBe(ROOT)
    expect(planBash('find . -name "*.java" | xargs grep -l Foo', ROOT, HOME).scanBase).toBe(ROOT)
  })

  test('出力の各行からパスの候補を拾う', () => {
    expect(pathsOfLine('src/A.java:12:  int x = 1;')).toEqual(['src/A.java'])
    expect(pathsOfLine('src/A.java')).toEqual(['src/A.java'])
    expect(pathsOfLine('src/A-1-2.java')).toEqual(['src/A-1-2.java', 'src/A'])
    expect(pathsOfLine('src/A.java-13-  context')).toEqual(['src/A.java'])
    expect(pathsOfLine('    indented content')).toEqual([])
    expect(pathsOfLine('--')).toEqual([])

    const found = outputCandidates('src/A.java:1:x\nsrc/A.java:9:y\n./lib/B.java\n\n--\n', ROOT, HOME)

    expect(found).toEqual([`${ROOT}/src/A.java`, `${ROOT}/lib/B.java`])
  })

  test('候補の数に上限がある', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `f${i}.txt`).join('\n')

    expect(outputCandidates(many, ROOT, HOME, 50)).toHaveLength(50)
  })
})

describe('Grep・Glob・LSP の結果', () => {
  test('Grep / Glob の filenames と content を拾う', () => {
    expect(searchToolCandidates({ filenames: ['/abs/A.java', 'rel/B.java'], numFiles: 2 }, '', ROOT, HOME)).toEqual([
      '/abs/A.java',
      `${ROOT}/rel/B.java`,
    ])
    expect(searchToolCandidates({ mode: 'content', content: 'src/C.java:3:foo' }, '', ROOT, HOME)).toEqual([`${ROOT}/src/C.java`])
    expect(searchToolCandidates(undefined, 'src/D.java\n', ROOT, HOME)).toEqual([`${ROOT}/src/D.java`])
  })

  test('LSP の文章から拡張子付きのパスを拾う', () => {
    const text = 'Found 3 references across 2 files:\n\nsrc/main/A.java:\n  Line 10:5\n/abs/lib/B.kt:\n  Line 2:1\nDefined in ../C.ts:4:2'

    expect(lspCandidates(text, `${ROOT}/src`, HOME)).toEqual([
      `${ROOT}/src/src/main/A.java`,
      '/abs/lib/B.kt',
      `${ROOT}/C.ts`,
    ])
  })
})
