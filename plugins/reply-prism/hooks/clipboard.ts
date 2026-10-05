// reply-prism 独自: 書式付き（HTML）のテキストをクリップボードに入れる（macOS だけ）。
//
// `$.ui.copy` は文字列しか渡せず、Slack の入力欄は貼り付けた文字の mrkdwn（`*太字*` など）を解釈しない。Web ページから
// コピーしたときと同じく HTML とプレーンテキストの両方をクリップボードに入れれば、Slack に貼ると書式になる。
// macOS では `osascript -l JavaScript`（JXA）で NSPasteboard に `public.html` と `public.utf8-plain-text` を書く。
// 中身は標準入力に JSON で渡す（`$.process.run` は argv でシェルを通らず、引数の長さの上限にもかからない）。
// ここは純粋な定数と関数だけ。`$` を使う呼び出し（OS の判定と書き込み）は register.tsx にある（`$` はファイルをまたいで渡せない）。

/** 標準入力の `{ html, plain }` を一般のペーストボードに書き、両方書けたら `ok` を出す JXA。 */
export const PASTEBOARD_SCRIPT = [
  "ObjC.import('AppKit');",
  'function run() {',
  '  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;',
  '  const input = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);',
  '  const pb = $.NSPasteboard.generalPasteboard;',
  '  pb.clearContents;',
  "  const html = pb.setStringForType($(input.html), $('public.html'));",
  "  const plain = pb.setStringForType($(input.plain), $('public.utf8-plain-text'));",
  "  return html && plain ? 'ok' : 'failed';",
  '}',
].join('\n')

export const PASTEBOARD_ARGV = ['osascript', '-l', 'JavaScript', '-e', PASTEBOARD_SCRIPT] as const

/** ブラウザがコピーするときと同じく、文字コードを書いておく（読む側が UTF-8 と分かるように）。 */
export const HTML_PREFIX = '<meta charset="utf-8">'

export type RichText = { html: string; plain: string }

/** osascript の標準入力に渡す JSON。 */
export const pasteboardInput = (content: RichText): string => JSON.stringify({ html: HTML_PREFIX + content.html, plain: content.plain })
