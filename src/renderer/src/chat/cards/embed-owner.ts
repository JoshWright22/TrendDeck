import { useSyncExternalStore } from 'react'
import { MAX_LIVE, pickLive, webSpec } from '@shared/craft-web'

// which Craft embeds in the chat run their editor: of the ones you can see, the newest (or the
// one you asked for with Open here), at most MAX_LIVE and one per document. the others show a
// still. one that runs keeps running while you can see any of it, so scrolling never reloads it

interface Entry {
  id: string
  appId: string
  appName: string
  projectId: string
  at: number
  pinned: number
  visible: boolean
}

const entries = new Map<string, Entry>()
const requested = new Map<string, number>()
const subs = new Set<() => void>()
let live: Set<string> = new Set()
let version = 0

function recompute(): void {
  const cands = [...entries.values()]
    .filter((e) => webSpec(e.appId))
    .map((e) => ({ id: e.id, key: `${e.appId}|${e.projectId}`, visible: e.visible, rank: Math.max(e.at, e.pinned) }))
  const next = pickLive(cands, live, MAX_LIVE)
  version += 1
  live = next
  for (const fn of subs) fn()
}

export function registerEmbed(id: string, appId: string, appName: string, projectId: string, at: number): () => void {
  entries.set(id, { id, appId, appName, projectId, at, pinned: requested.get(id) ?? entries.get(id)?.pinned ?? 0, visible: false })
  requested.delete(id)
  recompute()
  return () => {
    entries.delete(id)
    recompute()
  }
}

export function setEmbedVisible(id: string, visible: boolean): void {
  const e = entries.get(id)
  if (!e || e.visible === visible) return
  e.visible = visible
  recompute()
}

// embeds you just asked for, the chat scrolls to them: one only starts while you can see it
const reveal = new Set<string>()

// true once for an embed that should scroll into view
export function takeReveal(id: string): boolean {
  return reveal.delete(id)
}

export function pinEmbed(id: string): void {
  reveal.add(id)
  const e = entries.get(id)
  if (!e) {
    requested.set(id, Date.now())
    if (requested.size > 50) requested.delete(requested.keys().next().value!)
    return
  }
  e.pinned = Date.now()
  recompute()
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}

// the embeds that run their editor now
export function useLiveEmbeds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => live)
}

// re-renders on any change, for readers of embedFor
export function useEmbeds(): number {
  return useSyncExternalStore(subscribe, () => version)
}

// the newest embed in the open chat for a project (any app), or for one app
export function embedFor(projectId: string, appId?: string): Entry | null {
  let best: Entry | null = null
  for (const e of entries.values()) {
    if (e.projectId !== projectId || (appId && e.appId !== appId)) continue
    if (!best || e.at > best.at) best = e
  }
  return best
}
