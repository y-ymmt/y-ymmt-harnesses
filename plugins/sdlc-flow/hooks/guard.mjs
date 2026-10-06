#!/usr/bin/env node
// sdlc-flow の関所（PreToolUse フック）。
//
// sdlc-flow が動いているブランチ（状態ファイルがあり phase が done 以外）でだけ判定する。
// それ以外のブランチや、git の外では何もしない（普段の作業を止めないため）。
//
// - deny: 既定ブランチへの push、force push、pre-commit / pre-push フックの迂回
// - ask:  phase が implement のときに、コミット済みのテストファイルを書き換えること
//
// 判定に失敗したときは何も出さずに終わる（ツールの実行は止めない）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 状態ファイルのフォルダ名（.git の下）。SKILL.md の state-file.md と揃える。 */
export const STATE_DIR = 'sdlc-flow'

/**
 * ブランチ名を状態ファイルのフォルダ名にする（`/` を `__` に）。
 * @param {string} branch
 */
export function branchDirOf(branch) {
	return branch.replaceAll('/', '__')
}

/**
 * 状態ファイルの先頭の YAML 風のヘッダーから、必要なキーだけを読む。
 * @param {string} text
 * @returns {{ phase: string, base: string }}
 */
export function parseState(text) {
	const head = text.match(/^---\n([\s\S]*?)\n---/)
	const get = key => {
		const m = head?.[1].match(new RegExp(`^${key}:[ \\t]*([^#\\n]*)`, 'm'))
		return m ? m[1].trim() : ''
	}
	return { phase: get('phase'), base: get('base') }
}

/**
 * シェルのコマンド文字列を、`&&` `||` `;` `|` `&` 改行で区切った文ごとの語の列にする。
 * 引用符とバックスラッシュは外す。完全なシェルの解析ではない（判定に足りる程度）。
 * @param {string} command
 * @returns {string[][]}
 */
export function splitCommand(command) {
	const statements = []
	let words = []
	let word = ''
	let inWord = false
	let quote = ''
	const endWord = () => {
		if (inWord) words.push(word)
		word = ''
		inWord = false
	}
	const endStatement = () => {
		endWord()
		if (words.length) statements.push(words)
		words = []
	}
	for (let i = 0; i < command.length; i++) {
		const c = command[i]
		if (quote) {
			if (c === quote) quote = ''
			else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
			else word += c
			continue
		}
		if (c === "'" || c === '"') {
			quote = c
			inWord = true
		} else if (c === '\\' && i + 1 < command.length) {
			word += command[++i]
			inWord = true
		} else if (c === ' ' || c === '\t') {
			endWord()
		} else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
			endStatement()
		} else {
			word += c
			inWord = true
		}
	}
	endStatement()
	return statements
}

/** git の大域オプションのうち、次の語を値として取るもの。 */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
/** git push のオプションのうち、次の語を値として取るもの。 */
const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
/** git commit の短いオプションのうち、値を取るもの（これより後ろの文字は値）。 */
const COMMIT_SHORT_WITH_VALUE = new Set(['m', 'F', 'c', 'C', 't'])

/**
 * refspec の送り先のブランチ名を返す（`+a:refs/heads/b` → `b`）。
 * @param {string} refspec
 */
export function destinationOf(refspec) {
	const spec = refspec.replace(/^\+/, '')
	const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
	return dst.replace(/^refs\/heads\//, '')
}

/**
 * 1 つの文（語の列）が関所に触れるかを判定する。
 * @param {string[]} words
 * @param {{ base: string, currentBranch: string }} ctx
 * @returns {string | null} 止める理由。触れなければ null
 */
export function checkStatement(words, ctx) {
	let i = 0
	const env = []
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) env.push(words[i++])
	if (words[i] === 'env') {
		i++
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) env.push(words[i++])
	}
	if (!/(^|\/)git$/.test(words[i] ?? '')) return null
	i++

	const configs = []
	while (i < words.length && words[i].startsWith('-')) {
		const w = words[i]
		if (GIT_GLOBAL_WITH_VALUE.has(w)) {
			if (w === '-c') configs.push(words[i + 1] ?? '')
			i += 2
		} else {
			i++
		}
	}
	const sub = words[i]
	const args = words.slice(i + 1)
	if (!['commit', 'push', 'merge'].includes(sub)) return null

	if (env.some(e => /^(LEFTHOOK|HUSKY)=(0|false)$/i.test(e))) {
		return `フックを止める環境変数（${env.join(' ')}）を付けた git ${sub} は、sdlc-flow の実行中は使えません。フックが落ちる原因を直すか、ユーザーに聞いてください`
	}
	if (configs.some(c => /^core\.hookspath=/i.test(c))) {
		return `core.hooksPath を差し替えた git ${sub} は、sdlc-flow の実行中は使えません`
	}
	if (args.includes('--no-verify')) {
		return `--no-verify で git ${sub} のフックを飛ばすことは、sdlc-flow の実行中は使えません。フックが落ちる原因を直すか、ユーザーに聞いてください`
	}

	if (sub === 'commit') {
		for (const a of args) {
			if (a === '--') break
			if (!/^-[A-Za-z]+$/.test(a)) continue
			for (const ch of a.slice(1)) {
				if (ch === 'n') return '-n（--no-verify）で git commit のフックを飛ばすことは、sdlc-flow の実行中は使えません'
				if (COMMIT_SHORT_WITH_VALUE.has(ch)) break
			}
		}
		return null
	}

	if (sub === 'push') {
		const positional = []
		for (let j = 0; j < args.length; j++) {
			const a = args[j]
			if (PUSH_WITH_VALUE.has(a)) {
				j++
				continue
			}
			if (/^--force(-with-lease|-if-includes)?(=|$)/.test(a) || a === '--mirror') {
				return `force push（${a}）は、sdlc-flow の実行中は使えません`
			}
			if (/^-[A-Za-z]+$/.test(a) && a.includes('f')) return `force push（${a}）は、sdlc-flow の実行中は使えません`
			if (!a.startsWith('-')) positional.push(a)
		}
		const refspecs = positional.slice(1)
		for (const r of refspecs) {
			if (r.startsWith('+')) return `force push（refspec ${r}）は、sdlc-flow の実行中は使えません`
			const dst = r === 'HEAD' ? ctx.currentBranch : destinationOf(r)
			if (ctx.base && dst === ctx.base) {
				return `既定ブランチ ${ctx.base} への push（${r}）は、sdlc-flow の実行中は使えません。作業ブランチに push して PR を作ってください`
			}
		}
		if (refspecs.length === 0 && ctx.base && ctx.currentBranch === ctx.base) {
			return `既定ブランチ ${ctx.base} にいる状態での push は、sdlc-flow の実行中は使えません`
		}
	}
	return null
}

/**
 * テストファイルらしいパスか（リポジトリのルートからの相対パス）。
 * @param {string} path
 */
export function isTestPath(path) {
	const p = path.replaceAll('\\', '/')
	const name = p.slice(p.lastIndexOf('/') + 1)
	return (
		/(^|\/)(tests?|__tests__|specs?)\//i.test(p) ||
		/^test_.+\.py$/.test(name) ||
		/_test\.[A-Za-z0-9]+$/.test(name) ||
		/\.(test|spec)\.[A-Za-z0-9]+$/.test(name) ||
		/Tests?\.(java|kt|cs|swift)$/.test(name)
	)
}

/**
 * フックの入力から判定を決める。
 * @param {any} input PreToolUse の入力
 * @param {{ git: (args: string[]) => string | null }} deps git を呼ぶ関数（テストで差し替える）
 * @returns {{ decision: 'deny' | 'ask', reason: string } | null}
 */
export function decide(input, deps) {
	const tool = input?.tool_name
	const toolInput = input?.tool_input ?? {}

	// git を呼ぶ前に、関係のない呼び出しを安く見送る。
	if (tool === 'Bash') {
		const cmd = String(toolInput.command ?? '')
		if (!/\bgit\b/.test(cmd)) return null
	} else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
		const p = String(toolInput.file_path ?? toolInput.notebook_path ?? '')
		if (!p || !isTestPath(p)) return null
	} else {
		return null
	}

	const gitDir = deps.git(['rev-parse', '--absolute-git-dir'])
	const branch = deps.git(['branch', '--show-current'])
	if (!gitDir || !branch) return null
	const statePath = join(gitDir, STATE_DIR, branchDirOf(branch), 'state.md')
	const stateText = deps.readFile(statePath)
	if (stateText === null) return null
	const state = parseState(stateText)
	if (!state.phase || state.phase === 'done') return null

	if (tool === 'Bash') {
		const base = state.base || defaultBranchOf(deps)
		for (const words of splitCommand(String(toolInput.command))) {
			const reason = checkStatement(words, { base, currentBranch: branch })
			if (reason) return { decision: 'deny', reason }
		}
		return null
	}

	if (state.phase !== 'implement') return null
	const top = deps.git(['rev-parse', '--show-toplevel'])
	if (!top) return null
	const raw = String(toolInput.file_path ?? toolInput.notebook_path)
	const abs = isAbsolute(raw) ? raw : resolve(deps.cwd, raw)
	const rel = relative(top, abs).replaceAll('\\', '/')
	if (rel.startsWith('..') || !isTestPath(rel)) return null
	if (deps.git(['cat-file', '-e', `HEAD:${rel}`]) === null) return null
	return {
		decision: 'ask',
		reason: `sdlc-flow の実装中に、コミット済みのテスト ${rel} を書き換えようとしています。テストではなくコードを直すのが原則です。テストの追加か、仕様の読み違いを直すときだけ許可してください`,
	}
}

/**
 * origin の既定ブランチ名。分からなければ空文字。
 * @param {{ git: (args: string[]) => string | null }} deps
 */
function defaultBranchOf(deps) {
	const ref = deps.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
	return ref ? ref.replace(/^origin\//, '') : ''
}

/** 実際に動かすときの依存。 */
function realDeps(cwd) {
	return {
		cwd,
		git: args => {
			try {
				return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
			} catch {
				return null
			}
		},
		readFile: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
	}
}

async function main() {
	let text = ''
	for await (const chunk of process.stdin) text += chunk
	const input = JSON.parse(text)
	const result = decide(input, realDeps(input.cwd || process.cwd()))
	if (!result) return
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: result.decision,
				permissionDecisionReason: result.reason,
			},
		}),
	)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {})
}
