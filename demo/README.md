# demo

README に貼っているデモ GIF（`gif/<プラグイン>.gif`）を撮る台本と道具。

Claude Code を [ttyd](https://github.com/tsl0922/ttyd) でブラウザに映し、そのブラウザを
[Playwright](https://playwright.dev/) で操作して、本物の画面を撮る。字幕や作り直した絵は使わない。

## 撮り方

```sh
cd demo
npm install            # 初回だけ
./record.sh            # 全部
./record.sh reply-prism next-prompts   # 指定したものだけ
```

要るもの: ログイン済みの `claude`、`ttyd`、`ffmpeg`、`node`。各プラグインはこの marketplace から入れておく
（`claude plugin marketplace add` したフォルダのものが使われる）。

1 本につき Claude（sonnet）へ 1〜3 回依頼するので、そのぶん利用量が減る。返事は毎回少しずつ変わる。

## 何をしているか

`record.sh` が 1 本ごとに次を行う。

1. `workspace/` を `/tmp/sample-app` に写して git リポジトリにする（Claude Code の見出しにはこのパスが出る）
2. 撮るプラグインだけを有効にした設定を作る（ほかのプラグイン・ステータスライン・MCP は切る。tokyo-board は時刻に関係なく出す）
3. 手元の環境変数を持ち込まずに `claude` を起動し、`ttyd` で `127.0.0.1` に映す
4. `run.mjs` がブラウザで開いて `scenes/<プラグイン>.mjs` の台本を動かし、Chrome の screencast で 1 コマずつ撮る
5. 返事を待つ間は早送りにして、`ffmpeg` で幅 960・12fps の GIF にする

録画のブラウザには OS のマウスカーソルが映らないので、矢印と押したときの波紋をページに描き足している（`lib.mjs` の `CURSOR`）。

録画中にプラグインが覚えた状態（touch-tree のペインを開いたなど）は、終わったら `~/.claude/plugins/store/` を元に戻す。

## 台本の書き方

`scenes/<プラグイン>.mjs` の default export に、`s`（`s.page` が Playwright のページ、`s.fast(速さ, 関数)` で
その間を早送り）を受け取る関数を書く。画面の文字は `screenText` で読み、`locate` で文字の位置（クリックする座標）を出す。

```js
import { ask, clickAt, locate } from '../lib.mjs'

export default async function (s) {
  await ask(s, 'README.md を読んで一言で要約して')   // 打つ → 送る → 返事を待つ（早送り）
  await clickAt(s.page, await locate(s.page, '[ コピー ]'))
  await s.page.waitForTimeout(2000)
}
```

失敗すると、そのときの画面を `gif/<プラグイン>.gif.failed.png` に残す。
