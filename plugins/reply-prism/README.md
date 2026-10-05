# reply-prism

Claude Code の返事（表・コード・Mermaid の図・ツール行・コマンドの出力）を色つきで描き直す
Claude Code プラグイン（function hooks）。

**[prismantis](https://github.com/NahumLitvin/prismantis)（作者 [Nahum Litvin](https://github.com/NahumLitvin)、MIT ライセンス）を元にした改変版**で、
コミット `b13de6c9ec39e01946943f67b07e5fae4aefd939`（2026-10-04、prismantis 0.6.0）を取り込み、次の 6 つを足している。

1. ファイルパスをエディタで開く（押して開くボタンと、cmd+クリックで開くリンク）
2. 表のコピー形式を選べる（Markdown・TSV・Slack）
3. 危ない語（`本番` `DELETE` `rm -rf` など）と、Claude が `==…==` で囲んだ注意箇所を赤背景で目立たせる
4. 長い表・コードブロックを畳む
5. 表を列で並べ替える
6. 返事まるごとコピー（貼り先ごとの形: Markdown・GitHub・Slack・Notion）

ボタン・トースト・コマンドの返事・`/config` の項目名は日本語にした。ツール行の動詞（`Ran` `Read` `Edited`）と
ターンの終わりの行は、Claude Code 自身の表示に合わせて英語のまま。

```
⏺ 原因は src/main/java/com/example/app/AppService.java:42 です。      ← パスはリンク（cmd+クリックで開く）
  本番 の users に DELETE を流す前に確認してください。               ← 本番・DELETE が赤背景

                                  [ ⧉ Markdown ] [ ⧉ TSV ] [ ⧉ Slack ]
  ジョブ ⇅   所要 ▼   最終実行 ⇅          版 ⇅
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  job-24    899ms   2026-09-25 04:48   v1.0.24
  ─────────────────────────────────────────────
  …（先頭 15 行）
  [ あと 33 行を表示 ]

  開く:  AppService.java:42  Foo.java                                  ← 押すとエディタで開く
  コピー: [ Markdown ] [ GitHub ] [ Slack ] [ Notion ]                 ← 返事全体を貼り先の形でコピー
```

（上は形の説明。実際の色と並びは端末で `/reply-prism demo` を出して確かめる。）

## 入れ方

```sh
claude plugin marketplace add y-ymmt/y-ymmt-harnesses
claude plugin install reply-prism@y-ymmt-harnesses
```

Claude Code 2.1.287 以降。入れた後、開いているセッションは `/reload-plugins` か開き直しが要る。

### 本家 prismantis と同時に有効にしない

どちらも同じ描画（`AssistantMessage` `CommandOutput` `ToolUse` `ToolGroup` `TurnDuration`）を自分で描き、下の段を呼ばない。
両方を有効にすると、**読み込み順で外側になった片方だけ**が描き、もう片方は何もしない（二重には描かれないが、
どちらが出るかは決まっていない）。また両方がプロンプトに図の注記（`diagramHints`）を添えるので、注記が 2 つ付く。
reply-prism を使うときは prismantis を `/plugin` で無効にする。

名前は衝突しないようにしてある: プラグイン名 `reply-prism`、コマンド `/reply-prism`、設定は `pluginConfigs["reply-prism@y-ymmt-harnesses"]`、
`$.state` のキーは `reply-prism.view` と `reply-prism.turn`。

## 足した機能

### 1. ファイルパスをエディタで開く

返事・表のセル・`インラインコード`・Read/Edit/Write のツール行に出るファイルパスを、押すとエディタがその行で開くようにする。
開き方は 2 つある。

- **押して開くボタン**: Read/Edit/Write のツール行のパスはボタンにする。返事の中にパスがあれば、返事の最後に
  `開く:`（薄字）に続けてパスごとのボタン（ファイル名、行番号があれば `Foo.java:42`）を 1 行に並べる（幅が足りなければ折り返す）。
  実在するファイルだけを並べる（相対パスは作業ディレクトリから探すので、別のリポジトリのファイルを相対パスで書くと出ない）。
  同じパス＋行番号は 1 つにまとめ、出てきた順に並べる。上限（`openRowMax`、既定 8）を超えた分は `ほか N 件` と薄字で出す。
  押すと、エディタの URL（下の表）を macOS は `open`、それ以外は `xdg-open` に渡して開く。どちらも無ければトーストで知らせる
- **リンク**: 文中・表のセル・インラインコードのパスは端末のリンク（OSC 8）にもする。
  端末のリンクの開き方（iTerm2・Ghostty・WezTerm・VS Code の端末などで cmd+クリック）で開く

> [!NOTE]
> Orca など、Claude Code を全画面表示（fullscreen）で使う端末では、リンクをクリックしても cmd+クリックしても開かない
> （全画面表示でクリックを受け取れるのはボタンなどに限られるため）。そこでは返事の最後の `開く:` の行かツール行のボタンを押す。
> ボタンの文字には色を付けられないので、ツール行のパスはパスの色ではなく普通の文字の色で出る。

- **拾う形**: `/abs/path/Foo.java`、`~/.zshrc`、`./a.ts`、`../lib/b.ts`、`src/main/java/com/example/app/Foo.java`。
  行番号は `:12`、`:12:5`、`:12-20`（始まりの行で開く）、`#L12` を読む
- **ファイルらしいものだけ**: 最後の要素に拡張子（`.zshrc` のようなドットファイルも含む）があるか、`Makefile` `Dockerfile`
  などの決まった名前のときだけリンクにする。`and/or`、`2026/10/05`、`/api/v1/users`、`src/main`（ディレクトリ）はリンクにしない。
  ツール行の `file_path` はファイルと分かっているので拡張子が無くてもボタンにする
- **相対パス**は、セッションの作業ディレクトリ（`$.session.cwd()`、セッション開始とプロンプト送信のたびに取り直す）から絶対にする。
  `~` はホーム
- **端末だけ**: デスクトップアプリなどは `https:` 以外のリンクを描かないので、そこではボタンもリンクも出さず色だけ（本家と同じ）
- 英数字と `._-@+` だけのパスを拾う。日本語や空白を含むパスは拾わない（日本語の文と切れ目が付けられないため）

| 設定 | 値 | 既定 |
|---|---|---|
| `editor` | `vscode` `vscode-insiders` `cursor` `windsurf` `zed` `idea` `file` `off` | `vscode` |
| `editorUrlTemplate` | URL のひな形。`{path}`（絶対パス、要素ごとに URL エスケープ済み）`{line}` `{col}`（無ければ 1）。空でなければ `editor` より優先 | 空 |
| `openRow` | `false` で返事の最後の `開く:` の行を出さない（ツール行のボタンとリンクは残る） | `true` |
| `openRowMax` | `開く:` の行に並べるボタンの数の上限（1〜100） | `8` |

作る URL（`/w/src/a.ts` の 12 行目の場合）:

| `editor` | URL |
|---|---|
| `vscode` `vscode-insiders` `cursor` `windsurf` | `vscode://file/w/src/a.ts:12`（スキーム名だけ違う） |
| `zed` | `zed://file/w/src/a.ts:12`（Zed の URL の形は未確認） |
| `idea` | `idea://open?file=%2Fw%2Fsrc%2Fa.ts&line=12`（IntelliJ 系。macOS で登録されるスキーム） |
| `file` | `file:///w/src/a.ts`（行番号なし。OS の既定のアプリで開く） |
| `off` | ボタンにもリンクにもしない（`editorUrlTemplate` が空のとき） |

> [!WARNING]
> OSC 8 のリンクを描けない端末では、Claude Code がリンクの後ろに URL を薄字で書き足す（エンジンの仕様）。
> そういう端末（Apple の「ターミナル」など）でうるさいときは `editor` を `off` にする。

### 2. 表のコピー形式

表の上のコピーボタンを、形式ごとに並べた（`[ ⧉ Markdown ] [ ⧉ TSV ] [ ⧉ Slack ]`）。押すたびに切り替える形より
1 回で済むので、並べる形にした。並べ替えていればその順で、畳んでいても全行をコピーする。

| 形式 | 中身 | 貼り先 |
|---|---|---|
| Markdown | 表の Markdown。並べ替えていなければ返事に書かれたとおり、並べ替えていれば作り直す | GitHub・Markdown のエディタ |
| TSV | タブ区切り。`**太字**` などの記法は外し、リンクは `文字 (URL)`。`"` を含むセルは `"` で囲む | Excel・Google スプレッドシート（1 セルずつ入る） |
| Slack | 列を空白で揃えて ```` ``` ```` で囲んだコードブロック（全角は 2 桁として揃える） | Slack（Markdown の表を描かないため） |

| 設定 | 値 | 既定 |
|---|---|---|
| `tableCopyFormats` | 並べるボタンをカンマ区切りで（`markdown` `tsv` `slack`）。空なら 3 つとも | `markdown,tsv,slack` |
| `copyButtons` | `false` でコピーボタンを全部出さない（本家の設定） | `true` |

**Notion に貼るとき（推測・未確認）**: Notion は貼り付けた Markdown を変換するので、**Markdown** を貼ると表になる
可能性が高いと考えている。TSV は Notion では 1 行ずつの文字として入る可能性がある。どちらも実際の貼り付けでは
確かめていない（このプラグインのテストでは確かめられない）ので、使ってみて README を直す。

Slack のコードブロックのフォントでは全角文字がちょうど 2 桁にならないことがあり、日本語の多い表は少しずれる。

### 3. 危ない語を目立たせる

2 つの仕組みを併せて使う。どちらも白文字＋赤背景＋太字（`mono` テーマでは反転＋太字）で描く。

| 仕組み | 何を拾うか | どこで効くか |
|---|---|---|
| 語の一覧 | 決まった語（下の既定の語）に正規表現で当てる。文脈は見ない | 文・表・インラインコード・コードブロック・ツール行 |
| Claude の判定 | 返事を書く Claude 自身が、特に注意すべき箇所を `==…==` で囲む | 文・リスト・見出し・引用・表のセル（コードの中は除く） |

#### 語の一覧

既定の語: `本番` `production` `prod` `DELETE` `UPDATE` `DROP` `TRUNCATE` `ALTER` `--force` `--hard` `rm -rf` `rm -fr`。
返事の文・表・インラインコード・コードブロック・ツール行のコマンド（`Ran …`）・まとめた行の `last:` で当てる。

- **語の境目**: 英数字で始まる・終わる語は、前後が英数字でないときだけ当たる。`prod` は `prod-db` に当たり、`product` には当たらない。
  `本番` のような日本語は文字列のどこにでも当たる（`本番環境` も）
- **大文字小文字**: 大文字を含む語（`DELETE`）は文中では大文字だけに当たる（英文の "delete the file" を拾わない）。
  小文字だけの語（`production`）は区別しない。**シェル・SQL のコードブロックとツール行のコマンドの中では区別しない**（`delete from users` も当たる）
- 語の中の空白は 1 つ以上の空白に当たる（`rm  -rf` も当たる）

#### Claude の判定（`==…==`）

語の一覧では「この操作は元に戻せない」「全件が更新される」のような文脈で危ない箇所を拾えない。そこで、
プロンプトを送るたびにモデルだけが読む短い英語の注記（`dangerHints`、1 回約 90 トークン。図の注記 `diagramHints` と同じ仕組みで、
ユーザーには見えない）を添え、返事を書く Claude 自身に囲ませる。注記で頼んでいること:

- 取り返しのつかない操作・本番環境への影響・データの消失や全件更新・セキュリティ上の危険など、読み手が見落とすと困る箇所だけを囲む
- 囲むのは文全体ではなく要点の短い語句で、1 つの返事で数か所まで。ただの強調には使わない（強調は `**太字**`）
- コードブロックとインラインコードの中には書かない（コードの中は語の一覧で強調される）

reply-prism は `==` で挟まれた部分を危ない語と同じ見た目で描き、`==` は描かない。中に太字・パス・数があってもそのまま描く
（色だけ危ない語の文字の色に揃える。パスはリンクのまま、`開く:` の行にも出る）。次のものは印にせず、書かれたとおりの文字で描く:

- コードブロック・インラインコードの中の `==`（`a == b` などの比較）
- 対になっていない `==`、空の `====`、中身が空白で始まる・終わるもの（`== ==` `a == b == c`）、英数字に挟まれた `x==y`、`===`
- 改行をまたぐもの（1 行の中で閉じていないもの）

`dangerHighlight` を `false` にすると、`==…==` は印を外した普通の文字で描き（記号も出さない）、注記も付けない。
`dangerHints` だけを `false` にすると注記を付けないが、返事に `==…==` があれば同じように描く。

- **コピー**: 表（Markdown・TSV・Slack のどれでも）・リスト・引用のコピーボタンでは `==` の印を外した文をコピーする（危ない語はそのまま残る）。
  コードブロックのコピーは書かれたまま。**Claude Code 標準の `/copy` は返事の元の文をコピーするので `==` が残る**
- **デスクトップ**などの端末以外の表示面でも、同じく赤背景で描き、`==` は描かない
- **reply-prism を切ると** Claude Code 標準の描画に戻り、`==` がそのまま見える（切った後のプロンプトには注記が付かないが、
  それまでの返事には `==` が残っている）。本家 prismantis だけで描いたときも同じ

| 設定 | 値 | 既定 |
|---|---|---|
| `dangerHighlight` | `false` で目立たせない（`==…==` は印を外した普通の文字で描き、注記も付けない） | `true` |
| `dangerHints` | `false` で Claude への注記を付けない（返事にある `==…==` は描く） | `true` |
| `dangerWords` | 既定の一覧を**置き換える**語。カンマか読点（、）で区切る | 空（既定の一覧） |
| `dangerWordsExtra` | 一覧に**足す**語。例 `商用,stg-db,--no-verify` | 空 |
| `dangerColor` / `dangerBackgroundColor` | 文字と背景の色（色の書き方は下の表） | 白 / `#d20f39` |

### 4. 長い表・コードブロックを畳む

`foldLines` 行より長い表（データ行の数）・コードブロックは、先頭 `foldPreviewLines` 行だけ見せ、下に
`[ あと 35 行を表示 ]` を置く。開くと下に `[ 畳む ]`、上（コピーボタンの横）にも `[ 畳む ]` が出る。
コードブロックの見出しには全体の行数（`── ts · 50 行`）を出す。コピーは畳んでいても全行。

開閉の状態はメッセージごと（`ui.render` の requestId）・ブロックごと（位置と中身のハッシュ）に `$.state` へ置く。
返事が流れてくる途中でブロックの中身が変わると、状態は畳んだ状態に戻る。セッションをまたいでは残らない。

| 設定 | 値 | 既定 |
|---|---|---|
| `foldLines` | この行数を超えたら畳む。`0` で畳まない | `40` |
| `foldPreviewLines` | 畳んだときに見せる行数 | `15` |

Mermaid を図にしたブロックは畳まない。

### 5. 表を列で並べ替える

データ行が 2 行以上の表は、見出しの右に `⇅` を置く。押すとその列で `▲` 昇順 → `▼` 降順 → 元の順と切り替わる。
別の列を押すとその列の昇順から。並べ替えてから畳むので、降順にすると上位だけが見える。

列の値の種類は、空でない値が**すべて**同じ形のときにその比べ方にする（混ざっていれば文字として比べる）。

| 種類 | 例 | 比べ方 |
|---|---|---|
| 数 | `1,234` `-5.2` `12%` `¥1,200` `42件` `250ms` `1m 20s` `3.5GB` `900MB` | 数として。時間（ms・s・m・h・d・秒・分・時間・日）と容量（K・M・G・T、KB・MiB など）は単位を揃える |
| バージョン | `v1.2.10` `2.1.289` `1.0.0-rc.1` | 点で区切った数の並び。`-rc.1` などは付いていないものより前（点が 1 つの `1.2` は数として比べる） |
| 日時 | `2026-10-05` `2026/10/05 12:34:56` `2026-10-05T03:04:05+09:00` `2026年10月5日` `10/05 12:34` `12:34:56` | 時刻として（時差も見る） |
| 文字 | それ以外 | 日本語の照合順。数字は数として（`item2` < `item10`）、大文字小文字は区別しない |

空・`-` `—` `N/A` `null` `なし` `不明` などは、昇順でも降順でも最後に回す。同じ値は元の順を保つ。

| 設定 | 値 | 既定 |
|---|---|---|
| `tableSort` | `false` で並べ替えのボタンを出さない | `true` |

### 6. 返事まるごとコピー

返事の最後に `コピー: [ Markdown ] [ GitHub ] [ Slack ] [ Notion ]` の行を置き、押すとその返事全体を貼り先に合う形に
書き直してクリップボードに入れる（トーストで「GitHub 用にコピーしました」などと出る）。ボタンは表・コードのコピーボタンと同じ作り
（ctrl+x tab で移って Enter、またはクリックを通す端末でクリック）で、デスクトップなど端末以外でも出す。

- **範囲は返事全体**: 1 回の返事はツール呼び出しを挟んで複数のテキストブロックに分かれる。依頼（ツールの結果ではないユーザーの行）から
  次の依頼までの Claude のテキストを全部、空行 1 つでつないでコピーする。ボタンの行はその返事の**最後のテキストブロックの下にだけ**出す
- **返事が終わってから出る**: ターンの途中は出さず、ターンが終わった時点で最後のテキストブロックの下に出る（それまでのブロックには出ない）
- ツールの呼び出し・結果・考えている途中の文は入らない。`/reply-prism demo` などコマンドの出力は返事ではないので出ない

| 形式 | 中身 | 貼り先 |
|---|---|---|
| Markdown | 返事に書かれたとおりの Markdown。`==…==` の印は外す。GitHub の囲み `> [!NOTE]` は、どこでも読める `> **Note**` と本文の引用に | Markdown のエディタ・ファイル |
| GitHub | GFM。囲み・表・mermaid・コードの言語名はそのまま。`==x==` は `**x**` | GitHub の Issue・PR のコメント |
| Slack | **macOS では書式付きのテキスト**（Web ページからコピーしたときと同じ HTML と、書式記号の無いプレーンテキスト）。Slack の入力欄に貼ると太字・斜体・取り消し・コード・リンク・リスト・引用が書式になる。見出しは太字の段落、コードブロックは言語名なし（mermaid も図のソースのまま）、表は Slack に無いので「2.」の Slack と同じ桁を揃えたコードブロック、囲みは `⚠️ **Warning**` のように絵文字と太字のラベルの引用、`==x==` は太字。トーストは「Slack 用にコピーしました（書式付き）」。**macOS 以外・書けなかったとき**は mrkdwn の文字（`*太字*` `_斜体_` `~取り消し~` `` `code` ``、リンクは `text (url)`、リストは `•`）を入れ、トーストは「（文字だけ）」 | Slack |
| Notion | 貼ると見出し・リスト・コード（言語つき）・表・引用になる Markdown。囲みは `> ⚠️ **Warning**` のように絵文字とラベルの引用、mermaid は言語 `mermaid` のコードブロックのまま、`####` 以下の見出しは太字の 1 行（Notion の見出しは 3 段まで）、`==x==` は `**x**` | Notion |

例（返事が「ログを確認します。」→ ツール呼び出し → 下の文、の 2 つのテキストブロック）:

````
ログを確認します。

## 結果

**原因**は `app.yml` の ==本番の値の上書き== です。

> [!WARNING]
> 先にバックアップ
````

を Slack でコピーすると、macOS では次の HTML（とプレーンテキスト）が入る:

```html
<p>ログを確認します。</p><p><b>結果</b></p><p><b>原因</b>は <code>app.yml</code> の <b>本番の値の上書き</b> です。</p><blockquote>⚠️ <b>Warning</b><br>先にバックアップ</blockquote>
```

macOS 以外（文字だけ）では次の mrkdwn が入る:

````
ログを確認します。

*結果*

*原因*は `app.yml` の *本番の値の上書き* です。

> :warning: *Warning*
> 先にバックアップ
````

| 設定 | 値 | 既定 |
|---|---|---|
| `replyCopy` | `false` で「コピー:」の行を出さない（会話も読まない） | `true` |
| `replyCopyFormats` | 並べる形式をカンマ区切りで、この並びで（`markdown` `github` `slack` `notion`）。知らない名前は捨て、空なら 4 つとも | `markdown,github,slack,notion` |

`copyButtons` を `false` にしても、この行は `replyCopy` に従って出す。

**確かめていないこと**（テストでは書き直した文字列までしか見ていない）:

- Notion・GitHub・Markdown（返事まるごとコピー）は、macOS で実際に貼って確かめた。Notion では見出し・太字・斜体・取り消し・
  入れ子のリスト・番号付きリスト・表・言語つきのコード（`ts` は TypeScript になった）・mermaid の図・囲み（⚠️ Warning の引用）が
  そのまま書式になり、GitHub の Issue コメントでは囲み・表・mermaid の図まで描かれた
- Slack（書式付き）: macOS で実際に貼り、太字・斜体・取り消し・インラインコード・リンク・入れ子のリスト・番号付きリスト・
  コードブロック・表（桁揃えの `<pre>`）・囲み（⚠️ Warning の引用）が書式になることを確かめた。Slack は隣り合う `<pre>` どうし・
  `<blockquote>` どうしを 1 つにまとめ、段落の余白も詰めるので、ブロックの間に空の段落（`<p><br></p>`）を挟んでいる
  （挟んだあとも、表とコード・囲みと引用が別々のブロックになり、段落の間が適度に空くことを確かめた）。
  貼るときに書式を外す貼り方（cmd+shift+v など）では、プレーンテキストのほうが入る
- Slack（文字だけ）: 入力欄は貼り付けた文字の mrkdwn を解釈しない（実機で確かめた）ので、`*太字*` などは記号のまま残る。Slack の設定
  「マークアップでメッセージをフォーマットする」を有効にすると、貼った後に書式になるかもしれない（未確認）。日本語に挟まれた
  `*太字*`（`これは*大事*です`）は、Slack が前後に空白か記号を求めるため太字にならないことがある（未確認）
- GitHub の囲みを使わない汎用の Markdown では、`> **Note**` とその次の行は（ふつうの Markdown では）1 行につながって表示される

仕組み: 描画（`AssistantMessage`）には自分のテキストブロックの文しか来ず、`isFirstOfReply` もツール呼び出しの後のブロックごとに
`true` になる（実機で確かめた）。そこで `$.session.messages()` で会話を読み、そのブロックの文と同じ行を探して、入っている返事と、
それが返事の最後のテキストブロックかを決める。同じ文が何度も出てくるときは一番新しいほうとみなす。会話に見つからないブロック
（`/compact` の前の古い返事、会話の新しいほうから 4096 行より前など）には行を出さない。会話は描画のたびに読むと重いので、
ターンの始めと終わりまで使い回す。最後の返事のブロックだけが `$.state` の `reply-prism.turn`（ターンが走っているか）を読み、
ターンの始めと終わりに書くことで描き直される（古い返事のブロックは読まないので描き直されない）。

## 本家から引き継いだ機能

本家の README（英語）に詳しい。ボタンの文言を日本語にしたほかは、下に書いた Mermaid の全角対応だけを直した。

- 15 のテーマ（`/reply-prism theme <name>`）と `mono`、20 の色の項目
- 表（見出しの色・罫線・寄せ・数の色・幅合わせ）、見出しの 4 つの形、入れ子のリスト、引用、GitHub の囲み（`> [!NOTE]` など）
- コード（Prism で 24 言語の色つけ、シェルの色つけ）
- Mermaid の図（フローチャート・シーケンス・状態・クラス・ER、`xychart-beta` の棒・折れ線グラフ）
  - **reply-prism で直したところ**: 本家（の同梱の beautiful-mermaid）は全角の文字も 1 マスと数えるので、
    日本語のラベルだと箱の右端や線がずれる。描く前に全角の文字を 1 マスの私用領域の文字 2 つに置き換えて幅を取らせ、
    描いたあとで元に戻している（`hooks/mermaid.tsx`）
- 表と図が続くと横に並べる
- コピーボタン（`[ ⧉ コピー ]`、図は `⧉ ソース` と `⧉ 図`）。ctrl+x tab でボタンに移って Enter、
  またはクリックを通す端末（全画面表示）ならクリック
- ツール行を 1 行に（`Ran gh pr view 12`、`Read ~/src/app.ts`、まとめた行 `Ran 3 commands, read 2 files`）
- ターンの終わりの行の時間に色
- スラッシュコマンドの出力も同じ描き方
- 図の注記（`diagramHints`）: 打ったプロンプトに、モデルだけが読む短い英語の注記を添える（1 回約 150 トークン）
- ヘブライ語・アラビア語の右から左の描画（`/reply-prism demo-rtl`）

## コマンド

- `/reply-prism` — 使い方とテーマの一覧
- `/reply-prism theme <name>` — テーマを切り替える
- `/reply-prism demo` — すべての要素と、足した機能の見本（返事まるごとコピーの行はコマンドの出力には出ないので、説明だけ）
- `/reply-prism demo-rtl` — 右から左の見本

## 設定

`/config` の **reply-prism** の行で変えるか（`/plugin configure reply-prism@y-ymmt-harnesses` でも）、`~/.claude/settings.json` に書く。
書かなかった項目は既定の値になる。

```json
{
  "pluginConfigs": {
    "reply-prism@y-ymmt-harnesses": {
      "options": {
        "theme": "tokyo-night",
        "editor": "cursor",
        "tableCopyFormats": "tsv,slack",
        "dangerWordsExtra": "商用,stg-db",
        "foldLines": 60
      }
    }
  }
}
```

| 設定 | 値 | 既定 |
|---|---|---|
| `enabled` | `true` `false` | `true` |
| `theme` | `catppuccin-mocha` `catppuccin-latte` `dracula` `nord` `tokyo-night` `gruvbox-dark` `gruvbox-light` `rose-pine` `rose-pine-dawn` `everforest` `github-dark` `github-light` `one-dark` `solarized-dark` `solarized-light` `mono` | `catppuccin-mocha` |
| `tableStyle` | `rules` `grid` `minimal` | `rules` |
| `headingStyle` | `banner` `bold` `underline` `uppercase` | `banner` |
| `highlightNumbers` | `true` `false` | `true` |
| `highlightPaths` | `true` `false`（`false` にすると文中のパスはリンクにも `開く:` の行にも出ない。インラインコードのパスとツール行は残る） | `true` |
| `toolRows` | `true` `false` | `true` |
| `copyButtons` | `true` `false` | `true` |
| `diagramHints` | `true` `false` | `true` |
| `rtl` | `auto`、端末名（`warp` `kitty` `apple-terminal` `iterm` `ghostty` `wezterm` `vscode` `alacritty` `windows-terminal` `gnome` `konsole`）、`off` | `auto` |
| `mermaid` | `true` `false` | `true` |
| `mermaidAscii` | `true` `false` | `false` |
| `<token>Color` | 色（下の書き方）。項目は本家と同じ 20 個（`accentColor` `headingColor` `tableHeaderColor` `numberColor` `pathColor` など） | テーマ |
| `editor` `editorUrlTemplate` `openRow` `openRowMax` | 上の「1.」 | `vscode` / 空 / `true` / `8` |
| `tableCopyFormats` | 上の「2.」 | `markdown,tsv,slack` |
| `dangerHighlight` `dangerHints` `dangerWords` `dangerWordsExtra` `dangerColor` `dangerBackgroundColor` | 上の「3.」 | |
| `foldLines` `foldPreviewLines` | 上の「4.」 | `40` / `15` |
| `tableSort` | 上の「5.」 | `true` |
| `replyCopy` `replyCopyFormats` | 上の「6.」 | `true` / `markdown,github,slack,notion` |

色の書き方: 16 進（`#a6e3a1` `#fc0`）、`rgb(166,227,161)`、`ansi256(114)`、色名（`green` `cyanBright` など）。読めない値は無視する。

## 限界

- 本家と同じく、Markdown の解析は Claude が書くもの（見出し・リスト・表・コード・引用・強調・リンク）に絞っていて、CommonMark の全部ではない
- Claude Code は 20000 ノードを超える描画を受け付けず、そのときは自前の描画に戻る。色をつけたコードはおよそ 500 行、
  表はおよそ 1000 行が目安（本家の見積もり）。畳んでいる間は見せる行のぶんだけで済む
- 並べ替え・開閉はボタンを押したときに `$.state` を書いて描き直す。ボタンは ctrl+x tab で移るか、クリックを通す端末でクリック

## 動作環境と確かめた範囲

実機で確かめたのは macOS・端末 Orca・全画面表示・Claude Code 2.1.289 だけ。言葉の意味と共通の注意は
[リポジトリ直下の README](../../README.md#動作環境と確かめた範囲) を参照。

### 端末と表示面

| 環境 | 状態 | 補足 |
|---|---|---|
| macOS + Orca（全画面表示） | 確認済み | 色・表・図・ボタンは出る。`vscode://` のリンクはクリックでも cmd+クリックでも開かないので、開くのは `開く:` の行とツール行のボタンから |
| 全画面表示でない端末（main screen） | たぶん動く | 描き方は同じ。クリックは Mod に届かないので、ボタン（コピー・畳む・並べ替え・開く）は ctrl+x tab で移ってから Tab と Enter で押す。パスのリンクは端末自身が開く（OSC 8 を開ける端末なら cmd+クリックなど） |
| iTerm2・Ghostty・WezTerm・VS Code の端末 | 未確認 | OSC 8 のリンクを開ける端末として本家に倣って挙げているが、この改変版では試していない |
| Apple の「ターミナル」など OSC 8 を描けない端末 | 未確認 | リンクの後ろに URL が薄字で付く（上の WARNING）。テーマの色は 24bit 色で、出せない端末では近い色になるはず（Claude Code 任せ） |
| tmux の中 | 未確認 | リンクが外の端末まで届くかは tmux の設定次第 |
| 罫線を 2 桁で描く設定の端末 | 未対応 | 表・コードの枠・Mermaid の図の桁がずれる（推測）。罫線の無いフォントには `mermaidAscii` がある |
| デスクトップアプリ・VS Code 拡張・モバイル | 未確認 | 返事・ツール行・コマンドの出力は表示面を問わず描き直し、リンクと開くボタンだけ出さない（本家と同じ）。ターンの終わりの行は terminal でしか描かれない。テストは terminal と desktop の両方で描き、desktop でリンクとボタンが出ないことを見ている。VS Code 拡張・モバイルはテストも無い |
| `claude -p`・SDK | 未対応 | 描かない（Claude Code が描かないため）。`diagramHints` `dangerHints` の注記も付けない（送り元が端末の入力欄か Remote Control のときだけ付ける。コードでそうしている） |

### OS と開き方

| 環境 | 状態 | 補足 |
|---|---|---|
| macOS（`open`） | 確認済み | `editor` が `vscode` のときだけ実機で確かめた。`cursor` `idea` `file` と `editorUrlTemplate` は URL を作るところまでテストで見ている。`windsurf` `zed` はテストも無い |
| Linux（`xdg-open`） | 未確認 | `open` が無ければ `xdg-open` を試す。Debian・Ubuntu では `open` が別のコマンド（`openvt`）の別名のことがあり、そのときは失敗のトーストが出て `xdg-open` を試さない（コードからの推測） |
| Windows | 未対応 | 開くコマンド（`start` など）が無く、ボタンを押すと「見つかりません」のトーストになる。`C:\…` のパスはインラインコードに書かれたときだけ拾い、文中のドライブ文字つきのパス（`C:\…` `C:/…`）は拾わない。`~` は `HOME` が無いと展開しない |
| WSL・SSH 先・コンテナの中で動かす | 未対応 | 開くコマンドは Claude Code が動いている側で走る。手元の画面では開かず、URL もそちら側のパスを指す |

### OS と Slack の書式付きコピー

返事まるごとコピーの Slack を書式付き（HTML）で入れるのは **macOS 専用**。それ以外では今まで通り文字だけ（mrkdwn）を入れる。

| 環境 | 状態 | 補足 |
|---|---|---|
| macOS（端末・デスクトップアプリ・VS Code） | 書き込みは確認済み | 押したとき `uname -s` が `Darwin` なら（結果は覚える）、`osascript -l JavaScript`（JXA）で一般のペーストボードに `public.html` と `public.utf8-plain-text` を書く。中身は標準入力に JSON で渡し、シェルは通らない。書けたことは実機で読み戻して確かめた。Slack に貼った結果は未確認（上の「確かめていないこと」） |
| macOS で osascript が無い・失敗した | テストだけ | `$.ui.copy` で mrkdwn の文字を入れ、トーストは「（文字だけ）」 |
| Linux・Windows | テストだけ | osascript を呼ばずに文字だけ |
| SSH 越し（`SSH_CONNECTION` か `SSH_TTY` がある）・モバイルから押した | テストだけ | クリップボードが手元のものではないので、書式付きは試さずに `$.ui.copy`（端末の OSC 52 やモバイルのアプリ）で文字だけ |

- 足した 1〜5 の機能のテスト（`tests/reply-prism.test.tsx`）は `claude-code/testing` の terminal で、パスの拾い方・URL・`open` / `xdg-open`
  に渡す引数・トースト・コピーの中身を見ている。Windows のパスは開くボタンの key の読み戻しだけ
- `==…==` の注意箇所はテストで描き方・コピー・注記の有無を見ている（desktop も）。Claude が実際にどこを囲むか（注記の効き目）はテストでは確かめられない
- Notion への貼り付けは、「6. 返事まるごとコピー」の Notion 用を macOS で確かめた。「2. 表のコピー形式」の表だけのコピーは確かめていない
- 返事まるごとコピーは、端末（Orca ではない tmux の中の main screen）で、ツール呼び出しを挟んだ返事の最後のテキストブロックの下にだけ
  行が出ること、次の依頼の後も前の返事の行が残ることを実機で見た。ボタンを押したときのコピーの中身と、ターンの途中に出ないこと・
  終わると出ることはテスト（`tests/reply-copy.test.tsx`、terminal と desktop）で見ている。Slack の文字（mrkdwn）は
  入力欄に貼ると記号のまま残ることを実機で確かめ、macOS では書式付き（HTML）に変えた。書式付きを Slack に貼っては確かめていない

## 仕組み

```
.claude-plugin/plugin.json   manifest（userConfig・types）                       改変（名前・作者・日本語の項目・足した設定）
hooks/hooks.json             modules: ["./register.tsx"]                         本家のまま
hooks/register.tsx           フックと `$` を使う処理すべて                        改変（下の「足したもの」）
hooks/render.tsx             ブロック → Box/Text の木                             改変（危ない語と注意箇所・リンク・開くボタン・畳む・並べ替え・形式別コピー）
hooks/markdown.ts            Markdown → ブロック                                  改変（相対パスの検出、表のセルの元の書き方、`==…==` の注意箇所）
hooks/theme.ts               設定の読み込み                                        改変（足した設定）
hooks/help.ts                /reply-prism の画面                                  改変（日本語化・足した機能の見本）
hooks/presets.ts mermaid.tsx  テーマ・図                                       本家のまま
hooks/rtl.ts                 右から左                                             改変（注意箇所の節を太字などと同じに扱うだけ）
hooks/vendor/                Prism・beautiful-mermaid の同梱版                    本家のまま（scripts/ で作り直せる）
hooks/paths.ts               パスの検出・絶対化・エディタの URL・開くボタンの key  独自
hooks/danger.ts              危ない語の検出                                        独自
hooks/mark.ts                `==…==` の注意箇所の検出・コピー用に外す・Claude への注記  独自
hooks/table.ts               並べ替え（値の種類の判定）とコピー形式                独自
hooks/reply.ts               返事まるごとコピー（返事を集める・形式ごとの書き直し・Slack の HTML）  独自
hooks/clipboard.ts           書式付きコピーの JXA と argv（macOS のペーストボード）    独自
hooks/width.ts               表示幅                                               本家 render.tsx から切り出し（中身は同じ）
types/index.d.ts             $.state の契約（reply-prism.view・reply-prism.turn）  独自
tests/reply-prism.test.tsx   足した 1〜5 の機能のテスト                           独自
tests/reply-copy.test.tsx    返事まるごとコピーのテスト                            独自
tests/*.test.tsx（他）       本家のテスト                                          改変（名前・ボタンの文言・ボタンの数・ツール行のパス）
scripts/                     hooks/vendor を作り直すスクリプト                    本家のまま（package.json の名前と不要なスクリプトだけ変更）
docs/demo.md                 本家の見本の返事                                      本家のまま
LICENSE THIRD_PARTY_NOTICES.md  本家の MIT ライセンスと同梱物の表記                本家のまま（先頭に取り込み元を追記）
```

- 開閉・並べ替えの状態は `$.state` の `reply-prism.view`（メッセージごとの StateFamily）。描画中は書けないので、
  ボタンの `onPress` から `update()` で書き、読んでいる描画だけが描き直される。表かコードがあるメッセージだけが読む
- パスのリンクと開くボタンは、端末用の Style にだけリンクの関数と開く対象の関数を入れて切り替える（本家の Style をそのまま使い回す）
- 開くボタンの key は `open:<行>:<桁>:<絶対パス>`（無い行・桁は 0）。押されたら `ui.press` のフックが key から開く対象を戻して
  `$.process.run(['open', url])` を呼ぶ（状態を持たない）。他のボタンは今まで通り `onPress` で動く

## テスト・確認

```sh
claude plugin test plugins/reply-prism                 # 本家のテスト 111 件と、足した機能のテスト
claude plugin validate plugins/reply-prism --strict
```

テストは本家と同じ `claude-code/testing`（`claude plugin test`）で書いている（他のプラグインの `bun test` とは違う）。
型の確認は、`claude --plugin-dir plugins/reply-prism` で一度読み込むと `.claude-plugin/types/` ができるので、その後 `tsc -p plugins/reply-prism`
（`.claude-plugin/types/` はコミットしない）。

`hooks/vendor/` を作り直すとき（本家の手順）:

```sh
npm --prefix plugins/reply-prism/scripts ci
npm --prefix plugins/reply-prism/scripts run build:vendor
```

## ライセンス

[MIT](LICENSE)。prismantis（Copyright (c) 2026 Nahum Litvin）の改変版で、改変した部分も MIT で配る。
同梱しているライブラリとテーマの配色の出どころは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
