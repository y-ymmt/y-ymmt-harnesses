# touch-tree

> 帯を他のプラグインと共有したときの表示順の仕組みは、リポジトリ直下の README の「プロンプト上の帯の表示順」を参照。


このセッションで Claude（サブエージェントを含む）が**読んだ・編集したファイル**を、
リポジトリのツリーに沿ってペインに出す Claude Code プラグイン（function hooks）。
「どこを読んで答えたのか」を、深い Java パッケージでも場所ごと確かめられる。

```
✎編集 2  ●全体 3  ◐一部 1  ○検索 1
[ 検索のみを隠す ] [ クリア ]
──────────────────────────────────────────
example-app/                 7 ✎2
└ src/main/java/com/example/app/   6 ✎2
  ├ batch/                                2
  │ ├ ◐ FN22701.java        1-80,200-249/400
  │ └ ● FN27901.java                全120行
  └ web/                               4 ✎2
    ├ ✎ ApiController.java          ✎1 全88行
    ├ ○ ApiService.java                 検索
    └ ✚ NewDto.java                     新規
(外部)                                    1
└ ~/.claude/                              1
  └ ● CLAUDE.md                       全10行
```

## 使い方

- `/touch-tree` — ペインを開く（全画面レイアウトでは会話の横に置かれる）。一度開くと、次の
  セッションからは自動で開く（狭い端末では幅が空くまで待つ）。ペインの × で閉じると自動では開かない
- `/touch-tree clear` — 記録を空にする（`/clear` でも空になる）
- `/touch-tree hits` — 検索に出ただけのファイルを出す／隠すを切り替える（ペインのボタンと同じ）
- `/touch-tree close` — ペインを閉じる
- プロンプトのすぐ上（帯のいちばん下）に **［touch-tree を開く］／［touch-tree を閉じる］** を 1 行だけ固定で置く。押すたびに開け閉めする（閉じると次のセッションでは開かない）。帯を使う他のプラグイン（tokyo-board など）の描画はその上に並べる

設定項目は無い。

## 表示

| 記号 | 状態 | 右端 |
|---|---|---|
| `✚` 緑 | Write で新しく作った | `新規`（後で編集したら `✎回数`） |
| `✎` 橙 | Edit・Write（上書き）・NotebookEdit で書いた | `✎回数` と読んだ範囲 |
| `●` 青 | 全体を読んだ（範囲を重ねて全体になった場合も） | `全N行` |
| `◐` 薄紫 | 一部だけ読んだ | 読んだ行範囲（重なりはまとめる）`/総行数` |
| `○` 灰 | 検索（Grep・Glob・grep・find）や LSP の結果に出ただけ | `検索×回数` |

- 根は**作業ディレクトリの git ルート**。触ったファイルとその祖先ディレクトリだけを出す
- 子が 1 つのディレクトリしか無い連なり（`src/main/java/com/example/app/`）は 1 行にまとめる
- ディレクトリの右端は配下（孫以下も）の件数と、そのうち書いたものの数（`✎`）
- リポジトリ外のファイルは `(外部)` の枝にまとめる（ホーム配下は `~/` から）
- 最後に読んだ・書いたファイルは太字＋下線
- 狭いペインでは、深い罫線は先頭を `…` に、ディレクトリ名は先頭を、ファイル名は真ん中を切る
- **ファイル名は押すとエディタで開く**。ファイル名はボタンで、押すと `vscode://file/<絶対パス>` などの URL を
  `open`（macOS。無ければ `xdg-open`）に渡す。全画面の端末ではリンクのクリックを Claude Code が受け取って
  しまい開かないため、リンクではなくボタンにしている。ボタンの文字には色を付けられないので、状態は先頭の記号で
  見分ける。ディレクトリの行はボタンにしない（開くと新しいウィンドウになりがちなため）

### 設定

`/config` の touch-tree の行、または `~/.claude/settings.json` の `pluginConfigs` で変えられる。

| キー | 値 | 既定 |
|---|---|---|
| `editor` | ファイル名を押したときに開くエディタ。`vscode` / `cursor` / `idea` / `off`（ボタンにしない） | `vscode` |

## 何を記録するか

`tool.call` の入力と結果から拾う。失敗・拒否された呼び出しは数えない。

- **Read** — 結果の `startLine`・`numLines`・`totalLines` から行範囲。トークン上限で途中までに
  切られたものは一部とみなす。画像・PDF は全体
- **Edit / NotebookEdit / Write** — 書いた回数。Write は結果の `type` で新規か上書きかを分ける
- **Grep / Glob**（それらを持つ版） — 結果の `filenames` と content の各行
- **LSP** — 対象のファイルと、結果の文章に出てきたファイル
- **Bash** — ネイティブ版には Grep・Glob が無く grep・find で探すため、次も拾う
  - `cat` `bat` `nl` `less` → 全体、`head -n N` / `sed -n 'a,bp'` → その範囲、`tail` → 一部
  - `grep` `rg` `ugrep` `git grep` `find` `fd` の出力の `path:行:` や `path` の行 → 検索
  - `cd` は追う。`sed -i` やヒアドキュメントの本文、リダイレクト先は拾わない

Bash の出力から拾った候補は、`$.fs.stat` で実在するファイルだけを残す（1 回 400 件まで）。

## 仕組み

```
.claude-plugin/plugin.json   manifest（types: ./types/index.d.ts）
hooks/hooks.json             modules: ["./hooks.tsx"]
hooks/hooks.tsx              register()。フックとペインの描画
hooks/record.ts              記録（範囲の合算、状態、パスの正規化、Read の結果の読み方）
hooks/scan.ts                Bash・Grep・Glob・LSP の入出力からパスの候補を拾う
hooks/tree.ts                ツリーの組み立て（1 子ディレクトリの圧縮・外部の枝・件数）と幅合わせ
types/index.d.ts             $.state の契約（record・showHits）
tests/*.test.ts              bun test
```

- 記録は `$.state`（`touch-tree.record`）に置くので、ホットリロードしても残る
- ツール呼び出しのたびには書かず、300 ms まとめてから書く（描き直しの間引き。
  `$.ui.invalidate` は使わない）
- ペインの各行は別々の `Text`（1 つの `Text` が 1 万文字を超えると描画ごと拒否されるため）。
  出すのは 1500 行まで
- ボタンの処理は `ui.press` フックで行う（`$` をクロージャに閉じ込めない）
- 帯（AbovePrompt）は使わない。tokyo-board と取り合いになるのと、要約はペインの見出しで足りるため

## テスト・確認

```
bun test plugins/touch-tree/tests/
claude plugin validate --strict plugins/touch-tree
bun build plugins/touch-tree/hooks/hooks.tsx --target=bun --external claude-code
```

- テストは `claude-code/testing` を使わず、`bun:test` と偽の `$`・`on` で register() を動かす
- 読み込みの確認は `claude -p --model haiku --debug-file <log> "…"` で、ログに
  `plugin.register: touch-tree … admitted` が出ていて、`does not validate` が無いこと

## 参考

発想は [touch-map](https://github.com/y-hirakaw/claude-code-mods)（y-hirakaw, MIT）から得た
（読んだ行範囲を記録する、重ねて全体になったら全体とみなす、ペインに出す）。コードは独自に書いている。
