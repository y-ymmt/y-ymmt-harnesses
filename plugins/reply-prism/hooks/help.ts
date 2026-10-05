// 本家 prismantis の hooks/help.ts を元に、文言を日本語にし、reply-prism で足した機能
// （パスのリンク・表のコピー形式と並べ替え・折りたたみ・危ない語）の見本を加えたもの。

/** 折りたたみと並べ替えの見本にする長い表。 */
const longTable = (): string => {
  const rows = Array.from({ length: 48 }, (_, i) => {
    const n = i + 1
    const ms = (n * 37) % 900 + 12
    const day = String((n % 28) + 1).padStart(2, '0')
    return `| job-${n} | ${ms}ms | 2026-09-${day} 0${n % 10}:${String((n * 7) % 60).padStart(2, '0')} | v1.${n % 12}.${n} |`
  })
  return ['| ジョブ | 所要 | 最終実行 | 版 |', '| :--- | ---: | :--- | :--- |', ...rows].join('\n')
}

export const showcaseText = (themes: readonly string[]): string => `
# reply-prism

返事の Markdown を色つきで描く: **太字**、*斜体*、~~取り消し~~、\`インラインコード\`、[リンク](https://github.com/NahumLitvin/prismantis)、99.9% や 250ms のような数、~/src/app.ts のようなパス。

## コマンド

| コマンド | すること |
|---------|------|
| \`/reply-prism\` | この画面 |
| \`/reply-prism theme <name>\` | その場でテーマを切り替える |
| \`/config\` | どの設定も変えられる |

> [!NOTE]
> テーマは ${themes.length} 種類。\`mono\` は色を使わず、太字と薄字だけ。

### テーマを選ぶ

\`\`\`bash
/reply-prism theme nord
/reply-prism theme github-light
\`\`\`

1. 暗い背景: ${themes.filter(t => !/latte|light|dawn/.test(t) && t !== 'mono').join(', ')}
2. 明るい背景: ${themes.filter(t => /latte|light|dawn/.test(t)).join(', ')}
3. 色なし
   - mono

> [!TIP]
> 色の設定はテーマより優先される。\`/config\` で \`headingColor\` や \`numberColor\` に 16 進の色を入れる。

## reply-prism で足したもの

### パスをエディタで開く

src/main/java/com/example/app/AppService.java:42 や \`hooks/render.tsx:120\`、~/.zshrc は、返事の最後の「開く:」の行のボタンを押すとエディタが開く。端末のリンクの開き方（cmd+クリックなど）でも開く（全画面表示ではリンクのクリックは届かない）。

### 危ない語

本番の users テーブルに DELETE を流す前に、\`--force\` や rm -rf が混ざっていないか見る。

Claude が選んだ箇所も同じ見た目になる: このマイグレーションは ==元に戻せない== ので、先にバックアップを取る。

\`\`\`sql
delete from users where id = 1;
UPDATE orders SET status = 'done';
\`\`\`

### 長い表は畳み、見出しの ⇅ で並べ替える

${longTable()}

## ほかに描くもの

### 囲み

> [!IMPORTANT]
> プラグインを更新したら、開いているセッションで \`/reload\` が要る。

> [!WARNING]
> 選択するとコピーする端末（Warp など）では、コピーボタンのクリックが選択になることがある。キーボードの操作を使う。

> [!CAUTION]
> Claude Code は 20000 ノードを超える描画を受け付けない。色をつけたコードはおよそ 500 行を超えると素の文字に戻る。

### 引用と区切り線

> 引用をコピーすると、\`> \` の印を除いた文になる。

---

### コード

\`\`\`json
{ "theme": "dracula", "headingStyle": "banner", "mermaid": true }
\`\`\`

#### 図

\`\`\`mermaid
flowchart LR
    R[Reply] --> P[Parse]
    P --> D[Draw]
    D --> S[Screen]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant U as You
    participant C as Claude
    participant P as reply-prism
    U->>C: prompt
    C->>P: markdown
    P-->>U: colored reply
\`\`\`

\`\`\`mermaid
xychart-beta
    title "Color options per group"
    x-axis [text, head, num, code, diag]
    y-axis "options" 0 --> 8
    bar [7, 3, 2, 6, 2]
\`\`\`
`

export const helpText = (themes: readonly string[]): string => `
## コマンド

| コマンド | すること |
|---------|------|
| \`/reply-prism theme <name>\` | その場でテーマを切り替える |
| \`/reply-prism demo\` | すべての要素と図、足した機能の見本 |
| \`/reply-prism demo-rtl\` | ヘブライ語（右から左）の見本 |

### テーマ ${themes.length} 種類

- 暗い背景: ${themes.filter(t => !/latte|light|dawn/.test(t) && t !== 'mono').join(', ')}
- 明るい背景: ${themes.filter(t => /latte|light|dawn/.test(t)).join(', ')}
- 色なし: mono（太字と薄字だけ）

> [!TIP]
> 色の設定はテーマより優先される。\`/config\` で \`headingColor\` や \`numberColor\` に 16 進の色を入れる。

\`\`\`mermaid
flowchart LR
    R[Reply] --> P[Parse]
    P --> D[Draw]
    D --> S[Screen]
\`\`\`

\`\`\`mermaid
xychart-beta
    title "Color options per group"
    x-axis [text, head, num, code, diag]
    y-axis "options" 0 --> 8
    bar [7, 3, 2, 6, 2]
\`\`\`

> [!CAUTION]
> Claude Code は 20000 ノードを超える描画を受け付けない。色をつけたコードはおよそ 500 行を超えると素の文字に戻る。
`

export const rtlShowcaseText = (): string => `
# עברית מימין לשמאל

**שלום חברים**, זו הדגמה של עברית עם מונחים באנגלית כמו \`kubectl\`, מספרים כמו 99.9% ו-250ms, נתיב כמו ~/src/app.ts וגם [קישור](https://github.com/NahumLitvin/prismantis).

## רשימות

- פרוסים בשני אזורים (us-east ו-eu-west)
- מחליפים ערכת נושא עם \`/reply-prism theme nord\`

1. מתקינים את התוסף
2. שואלים שאלה בעברית

> עברית נקראת מימין לשמאל, גם בטרמינל בלי תמיכה בכיווניות

> [!TIP]
> כל ערכת נושא עובדת גם בעברית

| שירות | אזור | גרסה |
| :--- | :--- | ---: |
| שער | us-east | 2.14.0 |
| חיוב | eu-west | 1.8.3 |

\`\`\`bash
ls -la # רשימת הקבצים בתיקייה
\`\`\`
`
