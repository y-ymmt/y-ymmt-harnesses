# 状態ファイル

段階ごとの結果を残し、中断しても続きから再開できるようにするファイル。

## 場所

```
<git ディレクトリ>/sdlc-flow/<ブランチ名の / を __ にしたもの>/state.md
```

- `<git ディレクトリ>` は `git rev-parse --absolute-git-dir` の結果。worktree ごとに分かれ、コミットされない
- 例: ブランチ `feature/PROJ-12-csv-export` → `.git/sdlc-flow/feature__PROJ-12-csv-export/state.md`
- html-plan のページ（`plan.html`、`plan.packed.html`）も同じフォルダに置く

## phase の値

| 値 | 意味 | 再開したときにすること |
|---|---|---|
| `setup` | 0 の途中 | 0 の残りから |
| `grill` | 1 の途中 | 未回答の質問から壁打ちを続ける |
| `sizing` | 2 の途中 | 規模を判定し直す |
| `plan` | 3a/3b の途中 | 計画を作り直すか、途中のページを仕上げる |
| `plan-wait` | html-plan の Respond 待ち | ページの場所を伝え、回答を貼ってもらう |
| `implement` | 4 の途中 | `git log` と計画を突き合わせ、終わっていない作業から |
| `review` | 5 の途中 | レビューからやり直す |
| `pr` | 6 の途中 | 既存の PR を確かめ、push と PR 作成から |
| `done` | 完了 | PR の URL を伝える。別の作業なら新しいブランチで始める |

## 書式

```markdown
---
ticket: PROJ-12            # 無ければ空
ticket_url: https://...    # 無ければ空
branch: feature/PROJ-12-csv-export
base: main
phase: implement
plan_kind: html-plan        # html-plan / plan-mode
pr_url:
updated: 2026-10-06T15:04
---

## プロジェクト設定
- 仕様の調べ方: ...
- チェックコマンド: `make test`, `make lint`
- ブランチ命名 / コミット書式 / PR 書式: ...

## Intent
### <題>
- Problem: ...
- Proposed outcome: ...
- Affected users and systems: ...
- Constraints: ...
- Open questions: ...（誰に聞くか）
- 出典: <仕様書やチケットの URL>

## 規模の判定
- 判定: html-plan（理由: 5 ファイル・状態遷移が変わる）

## 計画
### 確定した主張（第 1 層）
1. ...
### 決定事項
1. <問い> → <答え>（既定のまま / 変更）
### 作業の順番
1. ...

## チェック結果
- `make test`: pass（2026-10-06 15:00）
- `make lint`: pass
- 回せなかったもの: ...（理由）

## レビュー
- 直した指摘: ...
- 直さなかった指摘: ...（理由）

## 未解決事項
- ...
```
