# y-ymmt-harnesses

Claude Code 用のプラグイン（marketplace）。

| プラグイン | 内容 |
|---|---|
| `turn-counter` | 作業中のスピナーをこのセッションのターン数（`ターン 12`）に差し替える。ツール拒否で「ざわっ！」を一瞬出す |
| `tokyo-board` | 17:00〜24:00 の間、プロンプト上の帯に東京の天気・運行情報（電光掲示板風）・警報・IT/AI ニュースを出す |
| `touch-tree` | このセッションで Claude が読んだ・編集したファイルを、リポジトリのツリーに沿ってペインに出す（`/touch-tree`） |
| `next-prompts` | ターンが終わるたびに、次に打ちそうな依頼の候補（haiku が会話から作る）をプロンプトの上にボタンで並べる。押すとその文が入力欄に入る（送信はしない） |

いずれも function hooks（Mods）で作っている。Claude Code 2.1.287 以降は追加の設定なしで動く。

## 入れ方

```sh
claude plugin marketplace add y-ymmt/y-ymmt-harnesses
claude plugin install turn-counter@y-ymmt-harnesses
claude plugin install tokyo-board@y-ymmt-harnesses
claude plugin install touch-tree@y-ymmt-harnesses
claude plugin install next-prompts@y-ymmt-harnesses
```

各プラグインの設定と仕組みは `plugins/<name>/README.md` を参照。

## プロンプト上の帯の表示順

`tokyo-board`・`touch-tree`・`next-prompts` は、プロンプトの上の帯（`AbovePrompt`）を共有して描く。
3 つとも入れたときは、読み込み順に関係なく次の並びになる。

```
（天気・運行のボード。夕方や［表示］を押したとき）
[ touch-tree を開く ]
[ 天気・運行を表示 ]
次の一手: [ 候補1 ] [ 候補2 ] …
──────────────────────
❯
```

- **仕組み**: 帯のフックは読み込み順に入れ子になり、その順番は Claude Code が決める（決め方は公開されて
  いない）。そこで各プラグインは、自分の行を並び順つきの枠（`key` が `y-ymmt-band:<順番>:<名前>` の `Box`）に
  入れる。先に `next(e)` で受け取った描画に枠があればいったんばらし、自分の枠と合わせて順番どおりに積み直す。
  どのプラグインが外側になっても、最後の結果は同じ並びになる
- **並び順の定義**: 各プラグインの `hooks/band.ts`。3 つとも同じ中身なので、行を足す・順番を変えるときは
  3 つとも揃える
- **1 つだけ入れたとき**: そのプラグインの行だけが出る
- **この約束を知らない他の人のプラグインと併用したとき**: 相手の行は帯のいちばん上（相手が外側なら
  こちらの行の下）に出る。相手が `next(e)` を呼ばずに描くと、こちらの行が消えることがある
