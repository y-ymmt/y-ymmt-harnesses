/**
 * 気象庁の警報・注意報と地震情報。
 *
 * どちらも `https://www.jma.go.jp/bosai/` の JSON をそのまま読む。ふだんは
 * 何も出さず、異常があるときだけ掲示板に 1 行だけ足す。
 *
 * - 警報・注意報: `warning/{府県コード}.json`。`areaTypes[].areas[].warnings[]` に
 *   `{ code, status }` が並ぶ。`status` が「解除」のものと、コードの無いもの
 *   （「発表警報・注意報はなし」）は出さない。
 * - 地震: `quake/data/list.json`。同じ地震（`eid`）について速報から詳報まで
 *   複数の行が積まれるので、`eid` ごとにいちばん詳しい行へまとめる。
 */

/** 警報・注意報の重さ。 */
export type Severity = 'emergency' | 'warning' | 'advisory'

/** 発表中の警報・注意報 1 件。 */
export type Warning = {
  /** 気象庁のコード（`03` など）。 */
  readonly code: string
  /** 「大雨警報」などの呼び名。 */
  readonly name: string
  /** 重さ。 */
  readonly severity: Severity
}

/** 出す地震 1 件。 */
export type Quake = {
  /** 地震そのものの id（同じ地震の続報はこれで揃う）。 */
  readonly eid: string
  /** 発生時刻（`HH:MM`）。 */
  readonly at: string
  /** 発生時刻（ミリ秒）。 */
  readonly atMs: number
  /** 震央地名。 */
  readonly place: string
  /** マグニチュード（取れなければ null）。 */
  readonly magnitude: number | null
  /** 全国の最大震度（`5-` などの表記のまま）。 */
  readonly maxIntensity: string
  /** 見ている都道府県での震度（無ければ null）。 */
  readonly localIntensity: string | null
}

/** 掲示板に出す「いま異常なこと」。 */
export type Alerts = {
  readonly warnings: readonly Warning[]
  readonly quake: Quake | null
}

/** 何も無いときの値。 */
export const NO_ALERTS: Alerts = { warnings: [], quake: null }

/**
 * 気象庁の警報・注意報コード表。
 *
 * 数が増えることはあるので、知らないコードは「その他」として拾う（黙って
 * 消すと、本物の警報が出ているのに画面が静かなままになるため）。
 */
export const WARNING_NAMES: Readonly<Record<string, string>> = {
  '02': '暴風雪警報',
  '03': '大雨警報',
  '04': '洪水警報',
  '05': '暴風警報',
  '06': '大雪警報',
  '07': '波浪警報',
  '08': '高潮警報',
  '10': '大雨注意報',
  '12': '大雪注意報',
  '13': '風雪注意報',
  '14': '雷注意報',
  '15': '強風注意報',
  '16': '波浪注意報',
  '17': '融雪注意報',
  '18': '洪水注意報',
  '19': '高潮注意報',
  '20': '濃霧注意報',
  '21': '乾燥注意報',
  '22': 'なだれ注意報',
  '23': '低温注意報',
  '24': '霜注意報',
  '25': '着氷注意報',
  '26': '着雪注意報',
  '27': 'その他の注意報',
  '32': '暴風雪特別警報',
  '33': '大雨特別警報',
  '35': '暴風特別警報',
  '36': '大雪特別警報',
  '37': '波浪特別警報',
  '38': '高潮特別警報',
}

/** 重さごとの色。特別警報がいちばん強い赤。 */
export const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  emergency: '#FF3B30',
  warning: '#FF9500',
  advisory: '#FFD60A',
}

/** 地震の色。 */
export const QUAKE_COLOR = '#FF5E5E'

/** 呼び名から重さを決める。 */
export function severityOf(name: string): Severity {
  if (name.includes('特別警報')) {
    return 'emergency'
  }

  return name.includes('警報') ? 'warning' : 'advisory'
}

/** 重い順に並べるための数。 */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  emergency: 0,
  warning: 1,
  advisory: 2,
}

/** 警報・注意報の URL。 */
export function warningUrl(area: string): string {
  return `https://www.jma.go.jp/bosai/warning/data/warning/${area}.json`
}

/** 地震情報の一覧。 */
export const QUAKE_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json'

/** 気象庁の「警報・注意報」ページ（⚠ 行のリンク先）。 */
export const WARNING_PAGE_URL =
  'https://www.jma.go.jp/bosai/warning/#area_type=japan&area_code=130000'

/**
 * 警報・注意報の JSON から、見たい区域のぶんを読む。
 *
 * 区域コードは前方一致で探す。`130010`（東京地方）を渡せば、府県ぜんぶを
 * 指す `130000` のような区分にも当たる。
 *
 * @param parsed `warning/{府県コード}.json` を JSON.parse したもの
 * @param area 見たい区域コード（東京地方は `130010`）
 */
export function parseWarnings(parsed: unknown, area: string): Warning[] {
  const root = parsed as { areaTypes?: unknown }
  const types = Array.isArray(root?.areaTypes) ? root.areaTypes : []
  const found = new Map<string, Warning>()

  for (const type of types) {
    const areas = Array.isArray((type as { areas?: unknown })?.areas)
      ? ((type as { areas: unknown[] }).areas as unknown[])
      : []

    for (const entry of areas) {
      const row = entry as { code?: unknown; warnings?: unknown }

      if (row?.code !== area) {
        continue
      }

      const list = Array.isArray(row.warnings) ? row.warnings : []

      for (const item of list) {
        const warning = item as { code?: unknown; status?: unknown }
        const code = typeof warning?.code === 'string' ? warning.code : null
        const status = typeof warning?.status === 'string' ? warning.status : ''

        if (code === null || status === '解除' || status.includes('はなし')) {
          continue
        }

        const name = WARNING_NAMES[code] ?? `その他の警報(${code})`

        found.set(code, { code, name, severity: severityOf(name) })
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code),
  )
}

/** いちばん重い警報の色（何も無ければ null）。 */
export function warningSeverityOf(warnings: readonly Warning[]): Severity | null {
  return warnings[0]?.severity ?? null
}

/** 震度の表記を強さの順番に直す。知らない表記は 0。 */
export function intensityRank(value: string): number {
  const table: Readonly<Record<string, number>> = {
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
    '5-': 5,
    '5弱': 5,
    '5+': 6,
    '5強': 6,
    '6-': 7,
    '6弱': 7,
    '6+': 8,
    '6強': 8,
    '7': 9,
  }

  return table[value.trim()] ?? 0
}

/** `2026-09-16T06:09:00+09:00` を `HH:MM` にする。 */
function clockOfIso(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '--:--'
}

/** 同じ地震の続報のうち、いちばん詳しい行を選ぶ。 */
function pickLatest(rows: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null
  let bestScore = -1

  for (const row of rows) {
    const hasInt = Array.isArray(row['int']) && (row['int'] as unknown[]).length > 0
    const ctt = String(row['ctt'] ?? '')
    const score = (hasInt ? 1e20 : 0) + Number(ctt.replace(/\D/g, '') || 0)

    if (score > bestScore) {
      best = row
      bestScore = score
    }
  }

  return best
}

/**
 * 地震の一覧から「いま出すべき 1 件」を選ぶ。
 *
 * 出す条件は次のどちらか。どちらでもなければ null（ふだんは何も出ない）。
 *
 * - 見ている都道府県で震度 1 以上を観測した
 * - 全国の最大震度が `5-` 以上だった
 *
 * どちらも、発生から `windowMin` 分のあいだだけ出す。
 *
 * @param parsed `quake/data/list.json` を JSON.parse したもの
 * @param when いまの時刻・窓の長さ（分）・見ている都道府県コード（東京は `13`）
 */
export function quakeOf(
  parsed: unknown,
  when: { readonly nowMs: number; readonly windowMin: number; readonly pref: string },
): Quake | null {
  const rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
  const byEvent = new Map<string, Record<string, unknown>[]>()

  for (const row of rows) {
    const eid = typeof row['eid'] === 'string' ? row['eid'] : null

    if (eid === null) {
      continue
    }

    byEvent.set(eid, [...(byEvent.get(eid) ?? []), row])
  }

  let chosen: Quake | null = null

  for (const [eid, group] of byEvent) {
    const row = pickLatest(group)

    if (row === null) {
      continue
    }

    const at = typeof row['at'] === 'string' ? row['at'] : ''
    const atMs = Date.parse(at)

    if (!Number.isFinite(atMs) || when.nowMs - atMs > when.windowMin * 60_000 || atMs > when.nowMs + 60_000) {
      continue
    }

    const maxIntensity = typeof row['maxi'] === 'string' ? row['maxi'] : ''
    const ints = Array.isArray(row['int']) ? (row['int'] as Record<string, unknown>[]) : []
    const local = ints.find(entry => entry['code'] === when.pref)
    const localIntensity = typeof local?.['maxi'] === 'string' ? local['maxi'] : null
    const isLocal = localIntensity !== null && intensityRank(localIntensity) >= 1
    const isBig = intensityRank(maxIntensity) >= intensityRank('5-')

    if (!isLocal && !isBig) {
      continue
    }

    const magnitude = Number(row['mag'])
    const quake: Quake = {
      eid,
      at: clockOfIso(at),
      atMs,
      place: typeof row['anm'] === 'string' ? row['anm'] : '震源不明',
      magnitude: Number.isFinite(magnitude) ? magnitude : null,
      maxIntensity,
      localIntensity,
    }

    if (chosen === null || quake.atMs > chosen.atMs) {
      chosen = quake
    }
  }

  return chosen
}

/** 地震の 1 行（`地震 06:09 熊本県天草・芦北地方 M4.0 最大震度4 東京3`）。 */
export function quakeTextOf(quake: Quake, prefName: string): string {
  const magnitude = quake.magnitude === null ? '' : ` M${quake.magnitude.toFixed(1)}`
  const max = quake.maxIntensity === '' ? '' : ` 最大震度${quake.maxIntensity}`
  const local = quake.localIntensity === null ? '' : ` ${prefName}${quake.localIntensity}`

  return `地震 ${quake.at} ${quake.place}${magnitude}${max}${local}`
}

/** ⚠ 行に流す文。何も無ければ空文字。 */
export function alertTextOf(alerts: Alerts, prefName: string): string {
  const parts: string[] = []

  if (alerts.warnings.length > 0) {
    parts.push(alerts.warnings.map(warning => warning.name).join(' '))
  }

  if (alerts.quake !== null) {
    parts.push(quakeTextOf(alerts.quake, prefName))
  }

  return parts.join('　')
}

/** ⚠ 行の色。地震があれば地震の赤、無ければいちばん重い警報の色。 */
export function alertColorOf(alerts: Alerts): string {
  if (alerts.quake !== null) {
    return QUAKE_COLOR
  }

  const severity = warningSeverityOf(alerts.warnings)

  return severity === null ? '#FFD60A' : SEVERITY_COLOR[severity]
}

/** ⚠ 行を出すか。 */
export function hasAlerts(alerts: Alerts): boolean {
  return alerts.warnings.length > 0 || alerts.quake !== null
}

/**
 * 知らせるべきものだけ拾う。
 *
 * 注意報は数が多くて毎日出るので黙って出すだけにし、警報・特別警報が
 * 新しく出たときと、条件に当たる地震が来たときだけトーストにする。
 *
 * @param before 前回の姿
 * @param after 今回の姿
 */
export function newAlertsOf(before: Alerts, after: Alerts): string[] {
  const was = new Set(before.warnings.map(warning => warning.code))
  const notes = after.warnings
    .filter(warning => warning.severity !== 'advisory' && !was.has(warning.code))
    .map(warning => warning.name)

  if (after.quake !== null && after.quake.eid !== before.quake?.eid) {
    notes.push(quakeTextOf(after.quake, '東京'))
  }

  return notes
}
