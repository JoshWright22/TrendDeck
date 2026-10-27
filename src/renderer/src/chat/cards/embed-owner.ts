import { useSyncExternalStore } from 'react'

// one live Craft app in the chat at a time: of the embeds you can see, the newest owns the docked
// window and the others show a still. "Open here" on an older one makes it the newest for now

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
const subs = new Set<() => void>()
let owner: string | null = null
let version = 0

function recompute(): void {
  let best: Entry | null = null
  for (const e of entries.values()) {
    if (!e.visible) continue
    if (!best || Math.max(e.at, e.pinned) > Math.max(best.at, best.pinned)) best = e
  }
  const next = best?.id ?? null
  version += 1
  owner = next
  for (const fn of subs) fn()
}

export function registerEmbed(id: string, appId: string, appName: string, projectId: string, at: number): () => void {
  entries.set(id, { id, appId, appName, projectId, at, pinned: entries.get(id)?.pinned ?? 0, visible: false })
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

export function pinEmbed(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.pinned = Date.now()
  recompute()
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function useEmbedOwner(): string | null {
  return useSyncExternalStore(subscribe, () => owner)
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
