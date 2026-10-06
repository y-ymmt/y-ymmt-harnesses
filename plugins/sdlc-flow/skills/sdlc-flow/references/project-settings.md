# プロジェクト設定の読み方

sdlc-flow は、プロジェクトごとに違う決まりを CLAUDE.md などから読み取って使う。専用の設定ファイルは作らない。

## 探す場所（上ほど優先）

1. ユーザーがこのコマンドの引数やチャットで直接言ったこと
2. リポジトリの `CLAUDE.md`（サブディレクトリの CLAUDE.md、`.claude/rules/` も含む）
3. `REVIEW.md`、`CONTRIBUTING.md`、`.github/pull_request_template.md`
4. ビルド定義から分かること（`Makefile`、`package.json` の scripts、`pyproject.toml`、`justfile` など）

## 集める項目

| 項目 | 例 | 見つからないとき |
|---|---|---|
| 仕様の調べ方 | 「仕様は notion-spec-researcher に任せる」「Drive の資料が正」 | 仕様書の場所を聞く。無ければチケットとコードだけで進める |
| チェックコマンド | `make test`、`make lint`、`npm run typecheck` | ビルド定義から候補を出して確かめてもらう |
| ブランチの命名規則 | `feature/PROJ-12-description` | `feature/<チケット番号>-<説明>` を使う（聞かない） |
| コミットメッセージの書式 | 「チケット番号＋日本語の要約」 | 直近 10 件の `git log` の書き方に合わせる（聞かない） |
| PR の書式と言語 | テンプレート、日本語 | `references/pr-body.md` の形・ユーザーの言語（聞かない） |
| レビュー観点 | REVIEW.md、CLAUDE.md のレビュー指示 | code-review の既定の観点だけで見る（聞かない） |
| 禁止事項 | 「admin から DB を直接編集しない」「apply は確認必須」 | 無いものとして進める（聞かない） |
| チケットの置き場所と読み方 | GitHub Issues、Jira、Notion の DB | チケット番号だけ渡されたときに聞く |

## 聞き方

- 「見つからないとき」の欄が「聞く」になっている項目だけを、**1 回の AskUserQuestion にまとめて**聞く
- 候補が出せるものは選択肢にして、推奨を先頭に置く
- 答えは状態ファイルの「プロジェクト設定」に書く。同じブランチで再開したときは聞き直さない
- 最後の報告で、CLAUDE.md への追記案として示す（CLAUDE.md は書き換えない）
