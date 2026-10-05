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

## プロンプト上の帯の表示順（前提）

`tokyo-board`・`touch-tree`・`next-prompts` は、プロンプトの上の帯（`AbovePrompt`）を共有して描く。
3 つとも入れたときは、次の並びになることを想定している。

```
（天気・運行のボード。夕方や［表示］を押したとき）
[ touch-tree を開く ]
[ 天気・運行を表示 ]
次の一手: [ 候補1 ] [ 候補2 ] …
──────────────────────
❯
```

- **仕組み**: 各プラグインは、先に `next(e)` で内側（自分より後に読まれたプラグイン）の描画を受け取り、
  自分の行をその**下**に足す。tokyo-board だけは、ボードを上・受け取った描画を中・自分のボタンを下に置く。
  外側にいるプラグインほど下に来る
- **前提**: どのプラグインが外側になるかは Claude Code が決める。型定義には「一覧の順で、先のものが外側
  （組織管理のプラグインが先）」とだけあり、順番の決め方は公開されていない。今の並びは、名前順
  （next-prompts → tokyo-board → touch-tree の順に外側）で読まれることを実機で 1 度確かめた結果に頼っている
- **保証できないこと**
  - Claude Code の読み込み順の決め方が変わると、行の上下が入れ替わる（描画が消えることはない）
  - 1 つだけ入れたときは、そのプラグインの行だけが出る（崩れない）
  - 他の人が作った帯を使うプラグインと併用したときの順番。相手が `next(e)` を呼ばずに描くと、
    こちらの行が消えることがある
- **崩れたときの直し方の候補**: 3 つの行に共通の印を付け、いちばん外側のプラグインが印の付いた行を
  決まった順で並べ直す仕組みを入れる（未実装）
