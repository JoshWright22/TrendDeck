// how each Craft app looks in the chat, kept per app across embeds: the size (the page's zoom)
// and, for FilmCraft, its settings and panel layout. FilmCraft's web build keeps neither itself,
// so TrendDeck reads them off the page while you work and puts them back when it embeds again.
// the layout comes back as FilmCraft dock actions (it has no command that sets a whole layout):
// panels you opened or closed, the sizes of its splits and the tab each group shows. pure, tested

export interface CraftWebView {
  zoom: number
  // FilmCraft's preferences (prefs.get values)
  prefs?: unknown
  // FilmCraft's dock layout as JSON: craft-ui's Layout ({root, floating}, ui.docking) or, before
  // FilmCraft used craft-ui, the bare frame tree (ui.inspect's ui.dock, splits of a and b)
  dock?: unknown
}

export const ZOOMS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25]
// a whole editor in a chat column: smaller than a window of its own
export const DEFAULT_ZOOM = 0.75

export function cleanZoom(z: unknown): number {
  const n = Number(z)
  if (!Number.isFinite(n)) return DEFAULT_ZOOM
  return ZOOMS.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), ZOOMS[0])
}

// the next size up (1) or down (-1)
export function stepZoom(z: number, dir: 1 | -1): number {
  const i = ZOOMS.indexOf(cleanZoom(z))
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))]
}

// ---- the dock layout ----

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

// one dock action as FilmCraft's window.dockAction takes it
export type DockAction = Json

// a node's kind and body: craft-ui writes them externally tagged ({"Split": {...}})
function tagOf(node: unknown): [string, Json] | null {
  const o = obj(node)
  if (!o) return null
  const keys = Object.keys(o)
  if (keys.length !== 1) return null
  const body = obj(o[keys[0]])
  return body ? [keys[0], body] : null
}

// every panel in a node or a layout, in order
export function panelsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) panelsIn(x, out)
    return out
  }
  const o = obj(v)
  if (!o) return out
  for (const [k, x] of Object.entries(o)) {
    if (k === 'panels' && Array.isArray(x)) {
      for (const p of x) if (typeof p === 'string' && !out.includes(p)) out.push(p)
    } else if (k === 'panel' && typeof x === 'string') {
      if (!out.includes(x)) out.push(x)
    } else if (k !== 'size' && k !== 'rect' && k !== 'native') {
      panelsIn(x, out)
    }
  }
  return out
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((p) => b.includes(p))

// the tab groups of a layout: their panels and the one showing
function groups(v: unknown, out: Array<{ panels: string[]; active: string | null }> = []): Array<{ panels: string[]; active: string | null }> {
  if (Array.isArray(v)) {
    for (const x of v) groups(x, out)
    return out
  }
  const o = obj(v)
  if (!o) return out
  if (Array.isArray(o.panels) && typeof o.active === 'number') {
    const panels = o.panels.filter((p): p is string => typeof p === 'string')
    out.push({ panels, active: panels[o.active] ?? null })
  }
  for (const [k, x] of Object.entries(o)) if (k !== 'panels') groups(x, out)
  return out
}

// the splits along split-only paths from the root, as ResizeSplit takes them. a split's children
// are first and second, or a and b in the older tree
function splits(node: unknown, path: boolean[] = [], out: Array<{ path: boolean[]; axis: unknown; size: unknown; first: string[]; second: string[] }> = []) {
  const t = tagOf(node)
  if (!t || t[0] !== 'Split') return out
  const b = t[1]
  const first = b.first ?? b.a
  const second = b.second ?? b.b
  out.push({ path, axis: b.axis ?? b.vertical, size: b.size, first: panelsIn(first), second: panelsIn(second) })
  splits(first, [...path, false], out)
  splits(second, [...path, true], out)
  return out
}

const rootOf = (layout: unknown): unknown => (tagOf(layout) ? layout : (obj(layout)?.root ?? null))

// first pass: the panels you opened (next to a panel they shared a group with) and closed
export function dockOpenClose(current: unknown, saved: unknown): DockAction[] {
  const now = panelsIn(current)
  const want = panelsIn(saved)
  if (!now.length || !want.length) return []
  const acts: DockAction[] = []
  const savedGroups = groups(saved)
  for (const p of want) {
    if (now.includes(p)) continue
    const mates = savedGroups.find((g) => g.panels.includes(p))?.panels.filter((m) => m !== p && now.includes(m)) ?? []
    // one with nothing it was beside here would land somewhere arbitrary, it stays closed
    if (mates.length) acts.push({ Open: { panel: p, anchor: mates[0] } })
  }
  // never every panel: FilmCraft keeps at least one docked
  const closing = now.filter((p) => !want.includes(p))
  if (closing.length < now.length) for (const p of closing) acts.push({ Close: { panel: p } })
  return acts
}

// second pass, on the layout after the first: the split sizes and the tab each group shows
export function dockSizes(current: unknown, saved: unknown): DockAction[] {
  const acts: DockAction[] = []
  const have = splits(rootOf(current))
  for (const s of splits(rootOf(saved))) {
    const c = have.find((h) => h.path.length === s.path.length && h.path.every((x, i) => x === s.path[i]))
    if (!c || JSON.stringify(c.axis) !== JSON.stringify(s.axis) || !sameSet(c.first, s.first) || !sameSet(c.second, s.second)) continue
    if (JSON.stringify(c.size) !== JSON.stringify(s.size)) acts.push({ ResizeSplit: { path: s.path, size: s.size } })
  }
  const now = groups(current)
  for (const g of groups(saved)) {
    const c = now.find((n) => sameSet(n.panels, g.panels))
    if (c && g.active && c.active !== g.active) acts.push({ Activate: { panel: g.active } })
  }
  return acts
}

// FilmCraft's preferences as dotted keys (appearance.uiScale), the way prefs.set takes them
export function flatPrefs(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  const o = obj(v)
  if (!o) {
    if (prefix) out[prefix] = v
    return out
  }
  for (const [k, x] of Object.entries(o)) flatPrefs(x, prefix ? `${prefix}.${k}` : k, out)
  return out
}

// the preferences that differ from what the page has, to set back (keys the page doesn't have,
// from another version, are left out)
export function prefsToRestore(current: unknown, saved: unknown): Record<string, unknown> {
  const now = flatPrefs(current)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(flatPrefs(saved))) if (k in now && JSON.stringify(now[k]) !== JSON.stringify(v)) out[k] = v
  return out
}
