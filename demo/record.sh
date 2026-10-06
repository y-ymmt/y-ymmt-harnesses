#!/bin/zsh
# README のデモ GIF を撮る。
#   ./record.sh reply-prism            1 本だけ
#   ./record.sh                        全部
# 要るもの: claude（ログイン済み）、ttyd、ffmpeg、node（npm install 済み）
set -euo pipefail

DEMO=${0:A:h}
WORK=/tmp/sample-app            # Claude Code の見出しに出るので、見せてよい名前にする
PORT=${PORT:-7681}
ALL=(reply-prism next-prompts prompt-trail touch-tree tokyo-board turn-counter)
PLUGINS=(${@:-$ALL})
TMP=$(mktemp -d)
STORE=$HOME/.claude/plugins/store

for tool in claude ttyd ffmpeg node; do
  command -v $tool >/dev/null || { echo "$tool が見つからない" >&2; exit 1 }
done
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ポート $PORT が使われている（別の ttyd が残っていないか確かめる。PORT=7682 ./record.sh で変えられる）" >&2
  exit 1
fi
[[ -d $DEMO/node_modules ]] || (cd $DEMO && npm install --silent)

cleanup() {
  [[ -n ${TTYD_PID:-} ]] && kill $TTYD_PID 2>/dev/null || true
  # 録画中にプラグインが覚えた状態（ペインを開いたなど）を元に戻す
  for f in $TMP/store/*(N); do cp $f $STORE/${f:t}; done
}
trap cleanup EXIT
mkdir -p $TMP/store
cp $STORE/*_y-ymmt-harnesses-*.json $TMP/store/ 2>/dev/null || true

for plugin in $PLUGINS; do
  [[ -f $DEMO/scenes/$plugin.mjs ]] || { echo "scenes/$plugin.mjs が無い" >&2; exit 1 }

  # 毎回まっさらな見本のリポジトリから始める
  [[ -e $WORK ]] && mv $WORK $TMP/old-$plugin-$RANDOM
  cp -R $DEMO/workspace $WORK
  (cd $WORK && git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init)

  # 撮るプラグインだけを有効にし、ステータスラインを消し、tokyo-board は時刻に関係なく出す
  jq --arg keep "$plugin@y-ymmt-harnesses" '{
      enabledPlugins: ((.enabledPlugins // {}) | with_entries(.value = (.key == $keep)) | .[$keep] = true),
      statusLine: { type: "command", command: "printf \"\"" },
      pluginConfigs: { "tokyo-board@y-ymmt-harnesses": { options: { showFrom: "00:00", showUntil: "24:00" } } }
    }' $HOME/.claude/settings.json > $TMP/settings.json

  # 手元の環境変数（作業中のセッションの情報など）を持ち込まない
  cat > $TMP/claude.sh <<EOF
#!/bin/zsh
cd $WORK
exec env -i HOME="\$HOME" USER="\$USER" LOGNAME="\$USER" SHELL=/bin/zsh TERM=xterm-256color COLORTERM=truecolor FORCE_HYPERLINK=1 LANG=ja_JP.UTF-8 \\
  PATH="$PATH" \\
  claude --settings $TMP/settings.json --model sonnet --strict-mcp-config --mcp-config '{"mcpServers":{}}' 2>>$TMP/claude.err
EOF
  chmod +x $TMP/claude.sh

  ttyd -p $PORT -i 127.0.0.1 -W -t fontSize=15 -t 'theme={"background":"#1e1f29"}' $TMP/claude.sh >$TMP/ttyd.log 2>&1 &
  TTYD_PID=$!
  sleep 1
  # プラグインのフォルダに置くと、インストールのたびに GIF まで配られるので demo/gif に置く
  mkdir -p $DEMO/gif
  node $DEMO/run.mjs $plugin $PORT $DEMO/gif/$plugin.gif
  kill $TTYD_PID 2>/dev/null || true
  TTYD_PID=
  sleep 1
done
