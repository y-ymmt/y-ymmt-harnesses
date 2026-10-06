/**
 * hooks/guard.mjs のテスト。`bun test` で走る（git は偽の関数に差し替える）。
 *
 *   bun test plugins/sdlc-flow/tests/
 */
import { describe, expect, test } from 'bun:test'

import { checkStatement, decide, destinationOf, isTestPath, parseState, splitCommand } from '../hooks/guard.mjs'

const STATE = (phase: string, base = 'main') => `---\nticket: PROJ-1\nbranch: feature/PROJ-1-x\nbase: ${base}\nphase: ${phase}   # コメント\n---\n\n## Intent\n`

/** 偽の依存。`head` は HEAD にあるファイル（ルートからの相対パス）。 */
function fakeDeps(opts: { state?: string | null; branch?: string; head?: string[]; originHead?: string } = {}) {
	const { state = STATE('implement'), branch = 'feature/PROJ-1-x', head = [], originHead = 'origin/main' } = opts
	return {
		cwd: '/repo',
		git: (args: string[]): string | null => {
			const key = args.join(' ')
			if (key === 'rev-parse --absolute-git-dir') return '/repo/.git'
			if (key === 'branch --show-current') return branch
			if (key === 'rev-parse --show-toplevel') return '/repo'
			if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return originHead
			if (args[0] === 'cat-file') return head.includes(args[2]!.replace(/^HEAD:/, '')) ? '' : null
			return null
		},
		readFile: (path: string): string | null =>
			path === `/repo/.git/sdlc-flow/${branch.replaceAll('/', '__')}/state.md` ? state : null,
	}
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (file_path: string) => ({ tool_name: 'Edit', tool_input: { file_path } })

describe('parseState', () => {
	test('phase と base を読み、行末のコメントは捨てる', () => {
		expect(parseState(STATE('plan-wait', 'master'))).toEqual({ phase: 'plan-wait', base: 'master' })
	})
	test('ヘッダーが無ければ空', () => {
		expect(parseState('# no header')).toEqual({ phase: '', base: '' })
	})
})

describe('splitCommand', () => {
	test('&& ; | で文に分け、引用符を外す', () => {
		expect(splitCommand(`git add . && git commit -m "a b; c" | cat`)).toEqual([
			['git', 'add', '.'],
			['git', 'commit', '-m', 'a b; c'],
			['cat'],
		])
	})
})

describe('destinationOf', () => {
	test.each([
		['main', 'main'],
		['HEAD:main', 'main'],
		['+feature:refs/heads/main', 'main'],
		['feature/x', 'feature/x'],
	])('%s → %s', (spec, dst) => expect(destinationOf(spec)).toBe(dst))
})

describe('checkStatement', () => {
	const ctx = { base: 'main', currentBranch: 'feature/x' }
	const check = (cmd: string) => checkStatement(splitCommand(cmd)[0]!, ctx)

	test.each([
		'git push origin main',
		'git push origin HEAD:main',
		'git push origin +feature/x',
		'git push --force origin feature/x',
		'git push --force-with-lease origin feature/x',
		'git push -uf origin feature/x',
		'git push --no-verify origin feature/x',
		'git commit --no-verify -m "x"',
		'git commit -nm "x"',
		'git commit -an -m x',
		'LEFTHOOK=0 git commit -m x',
		'env HUSKY=0 git push origin feature/x',
		'git -c core.hooksPath=/dev/null commit -m x',
		'git -C /repo push origin main',
	])('止める: %s', cmd => expect(check(cmd)).not.toBeNull())

	test.each([
		'git push -u origin feature/x',
		'git push origin HEAD',
		'git push -o ci.skip origin feature/x',
		'git commit -m "fix -n option"',
		'git commit -m x -n2',
		'git status',
		'git push --dry-run origin feature/x',
		'ls -la',
	])('通す: %s', cmd => expect(check(cmd)).toBeNull())

	test('既定ブランチにいて refspec なしの push は止める', () => {
		expect(checkStatement(['git', 'push'], { base: 'main', currentBranch: 'main' })).not.toBeNull()
	})
})

describe('isTestPath', () => {
	test.each([
		'app/apps/entries/tests/test_api.py',
		'test_util.py',
		'pkg/foo_test.go',
		'src/a.test.ts',
		'src/a.spec.tsx',
		'src/__tests__/a.ts',
		'src/test/java/FooTest.java',
	])('テスト: %s', p => expect(isTestPath(p)).toBe(true))
	test.each(['src/contest.py', 'app/latest.py', 'src/testing.ts'])('テストではない: %s', p =>
		expect(isTestPath(p)).toBe(false),
	)
})

describe('decide', () => {
	test('状態ファイルが無いブランチでは何もしない', () => {
		expect(decide(bash('git push --force origin main'), fakeDeps({ state: null }))).toBeNull()
	})
	test('phase が done なら何もしない', () => {
		expect(decide(bash('git push --force'), fakeDeps({ state: STATE('done') }))).toBeNull()
	})
	test('実行中なら既定ブランチへの push を deny', () => {
		expect(decide(bash('git push origin main'), fakeDeps())?.decision).toBe('deny')
	})
	test('base が空なら origin/HEAD の既定ブランチで判定する', () => {
		const deps = fakeDeps({ state: STATE('pr', ''), originHead: 'origin/master' })
		expect(decide(bash('git push origin master'), deps)?.decision).toBe('deny')
	})
	test('git を含まない Bash は見送る', () => {
		expect(decide(bash('make test'), fakeDeps())).toBeNull()
	})
	test('implement 中にコミット済みのテストを編集すると ask', () => {
		const deps = fakeDeps({ head: ['app/tests/test_api.py'] })
		expect(decide(edit('/repo/app/tests/test_api.py'), deps)?.decision).toBe('ask')
	})
	test('implement 中でも、まだコミットしていないテストは通す', () => {
		expect(decide(edit('/repo/app/tests/test_new.py'), fakeDeps())).toBeNull()
	})
	test('implement 以外の段階ではテストの編集を止めない', () => {
		const deps = fakeDeps({ state: STATE('review'), head: ['app/tests/test_api.py'] })
		expect(decide(edit('/repo/app/tests/test_api.py'), deps)).toBeNull()
	})
	test('テストでないファイルの編集は見送る', () => {
		expect(decide(edit('/repo/app/views.py'), fakeDeps({ head: ['app/views.py'] }))).toBeNull()
	})
	test('相対パスは cwd から解決する', () => {
		const deps = fakeDeps({ head: ['tests/test_a.py'] })
		expect(decide({ tool_name: 'Write', tool_input: { file_path: 'tests/test_a.py' } }, deps)?.decision).toBe('ask')
	})
})
