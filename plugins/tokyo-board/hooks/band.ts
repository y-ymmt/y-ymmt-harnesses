/**
 * プロンプトの上の帯を、このリポジトリのプラグインどうしで分け合うための約束。
 *
 * 帯のフックは読み込み順に入れ子になり、その順番は Claude Code が決める（公開された規則は無い）。
 * そこで各プラグインは自分の行を「並び順つきの枠」に入れて返し、受け取った描画に枠があれば
 * いったんばらしてから、自分の枠と合わせて並び順どおりに積み直す。
 * どのプラグインが外側になっても、最後に積み直した結果は同じ並びになる。
 *
 * tokyo-board / touch-tree / next-prompts が同じ中身のこのファイルを持つ。変えるときは 3 つとも揃える。
 */

/** 帯の上からの並び順。小さいほど上（入力欄から遠い）。 */
export const BAND_ORDER = {
  board: 10,
  touchTreeToggle: 20,
  boardToggle: 30,
  nextPrompts: 40,
} as const

const SLOT_PREFIX = 'y-ymmt-band:'
/** 積み直した帯の外枠。外側のプラグインはこれを見つけたらばらす。 */
export const BAND_STACK = `${SLOT_PREFIX}stack`

/** 並び順つきの枠の key。`<Box key={slotKey(...)}>` で自分の行を包む。 */
export const slotKey = (order: number, name: string): string => `${SLOT_PREFIX}${order}:${name}`

const keyOf = (node: unknown): string | null => {
  if (typeof node !== 'object' || node === null) return null
  const key = (node as { props?: Record<string, unknown> | null }).props?.['key']

  return typeof key === 'string' ? key : null
}

const childrenOf = (node: unknown): unknown[] => {
  const children = (node as { children?: unknown }).children

  return Array.isArray(children) ? children.flat(Infinity) : []
}

/** 枠なら並び順、そうでなければ null（他所の描画）。 */
const orderOf = (node: unknown): number | null => {
  const key = keyOf(node)

  if (key === null || !key.startsWith(SLOT_PREFIX) || key === BAND_STACK) return null

  const order = Number(key.slice(SLOT_PREFIX.length).split(':')[0])

  return Number.isFinite(order) ? order : null
}

/**
 * 受け取った描画（`await next(e)`）と自分の枠を合わせ、並び順どおりの子の並びにして返す。
 *
 * - engine の素の描画（帯を使うプラグインが他に無いとき）は捨てる（従来どおり）
 * - 他所のプラグインの描画は枠を持たないので、そのまま帯のいちばん上に残す
 */
export const stackBand = (beneath: unknown, mine: unknown[]): unknown[] => {
  const received =
    typeof beneath !== 'object' || beneath === null || (beneath as { type?: unknown }).type === 'engine'
      ? []
      : keyOf(beneath) === BAND_STACK
        ? childrenOf(beneath)
        : [beneath]
  const items = [...received, ...mine].filter(item => item !== null && item !== undefined && item !== false)
  const foreign = items.filter(item => orderOf(item) === null)
  const slots = items
    .filter(item => orderOf(item) !== null)
    .map((item, index) => ({ item, index, order: orderOf(item) as number }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ item }) => item)

  return [...foreign, ...slots]
}
