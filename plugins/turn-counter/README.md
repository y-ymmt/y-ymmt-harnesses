# turn-counter

ターン中のスピナーを、**このセッションで何ターン目か**の表示に差し替える Claude Code
プラグイン（function hooks）。ツールが拒否されると、その行が一瞬「ざわっ！」になる。

```
ターン 12
Sauteing
```

## 何が変わるか

ターン中の `Spinner`（terminal のみ）が、上から次の 2 行に差し替わる。

1. **ターン数の行** — `ターン 12` のように、今走っているターンを含めた番号を Claude オレンジ
   （`#D97757`、太字なし）で出す。1 回目の依頼中は `ターン 1`。
2. **元の spinner 文言** — `Sauteing` など（`spinnerVerbs` の設定がそのまま出る）を薄字で残す。
   複数行の AA を入れている場合は 1 行に均す。

### ざわっ！

ターン数の行は、次のときだけ 3 秒ほど一言に置き換わり、元に戻る。

| きっかけ | 出るもの |
|---|---|
| 可否判定（`tool.check`）が `deny`／結果側で拒否された `tool.call`（入力検証での拒否や、人が権限プロンプトで断ったもの） | 赤の太字で **ざわっ！** |

直近の拒否は動作確認用に `$.store` の `lastRefusal` に残る。

### ターン数の数え方

- 数えるのは**メインループのターンだけ**。サブエージェントの実行は `turn.start` を
  起こさないので数に入らない。
- 番号はセッション id（`$.session.id()`）ごとに `$.store` の `turns.<セッション id>` に残す。
  - **再開**（`claude --resume` / `--continue`）は同じ id なので**続きから**数える。
  - **新規**と **`/clear`** は id が新しくなるので **1 から**数え直す。`/clear` では
    `session.start` が鳴らないので、毎ターン id を引き直して見分けている。
  - 覚えておくのは最近使った 200 セッションまで。古いものから捨てる。
  - id や store が使えないときは、そのプロセスの中での回数を出す。
- このプラグインを入れる前から続いているセッションを再開した場合、それ以前のターンは
  数えていないので 1 から始まる。

### 差し替えないもの

- サブエージェントの画面のスピナー（`agent.spawn` で覚えたエージェント id と、
  メインのターンが走っているかで見分ける）
- ターンが走っていないあいだのスピナー
- terminal 以外の surface（Claude Desktop など）

## 使い方

`plugins/turn-counter/` に置いてあるので、セッションを開くと
`turn-counter@y-ymmt-harnesses` として読み込まれる。今のセッションに反映するには `/reload-plugins`。

設定項目は無い。やめたいときは

```
claude plugin disable turn-counter@y-ymmt-harnesses
```

## 動作環境と確かめた範囲

実機で確かめたのは macOS・端末 Orca・全画面表示・Claude Code 2.1.289 だけ。言葉の意味と共通の注意は
[リポジトリ直下の README](../../README.md#動作環境と確かめた範囲) を参照。

| 環境 | 状態 | 補足 |
|---|---|---|
| macOS + Orca（全画面表示） | 確認済み | |
| 全画面表示でない端末（main screen） | たぶん動く | スピナーは表示の形に依らず `Spinner` で描かれる。実機では見ていない |
| 他の端末（Apple の「ターミナル」・iTerm2・VS Code の端末・Windows Terminal など） | たぶん動く | 使うのは文字・色・太字だけ。`#D97757` は 24bit 色で、出せない端末では近い色になるはず（Claude Code 任せ） |
| Linux・Windows | たぶん動く | OS に依るコード（パス・外部コマンド）が無い。実機では見ていない |
| デスクトップアプリ・VS Code 拡張・モバイル | 未対応 | `e.surface !== 'terminal'` のときは素のスピナーのまま（コードでそうしている。テストで確認） |
| `claude -p`・SDK | 未対応 | スピナーが描かれないので何も変わらない。ターン数は `$.store` に数える |
| 英語など日本語以外の表示 | 未対応 | `ターン 12` と `ざわっ！` は日本語で固定 |

- テスト（`tests/hooks.test.ts`）は偽の `$` で、数え方・サブエージェントの見分け・terminal 以外で差し替えないことを見ている。
  実際の描画（色・幅）はテストでは見ていない
- 拒否の拾い方のうち、結果の文に `permission` を含むかで見る分は、Claude Code の英語の文言に頼っている。文言が変わると拾えなくなる

## 中身

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             modules: ["./hooks.tsx"]
hooks/hooks.tsx              register()。フックとスピナーの描画
hooks/zawa.ts                ターン数の文言・鍵・番号の決め方、ざわっ！の見た目、差し替える相手の判定
tests/hooks.test.ts          偽の `$` で hooks.tsx を動かすテスト（bun test）
```

hook しているイベント（`claude plugin validate plugins/turn-counter` で確認できる）:

- `session.start` — ざわっ！の消灯を見るタイマー（1 秒ごと。出ていないあいだは何もしない）を張る
- `turn.start` — メインのターンを 1 つ数えて `$.store` に残す
- `turn.complete` — メインのターンが終わったら差し替えをやめる
- `tool.check` — deny を見て「ざわっ！」を出す
- `tool.call` — 権限判定より手前で弾かれた呼び出し・人が断った呼び出しを結果側から拾う
- `agent.spawn` — サブエージェントの id を覚える（その画面のスピナーには手を出さない）
- `ui.render{component=Spinner}` — スピナーを描き替える

描き直し（`$.ui.invalidate`）を頼むのは、ざわっ！を出したときと消えたときだけ。

## テスト・確認

```
bun test plugins/turn-counter/tests/
claude plugin validate plugins/turn-counter
bun build plugins/turn-counter/hooks/hooks.tsx --target=bun --external claude-code
```

- テストは `claude-code/testing` を使わず、`bun:test` と偽の `$`・`on` で register() を動かす。
  `hooks.tsx` 冒頭の `@jsxRuntime classic` / `@jsx h` プラグマは、tsconfig を読まない場所から
  `bun test` しても、エンジンと同じく大域の `h` で JSX を組むためのもの。
- `claude plugin validate --strict` は、プラグイン名に「claude」を含むという警告で必ず失敗する。
  それ以外の警告・エラーが無ければよい。
- 読み込みの確認は `claude -p --model haiku --debug-file <log> "…"` で、ログに
  `plugin.register: turn-counter … admitted` が出ていて、`does not validate` が無いこと。
  描画木が弾かれると素の spinner が出て、ログに
  `ui.render (Spinner): a hook returned a tree that does not validate` が出る。
