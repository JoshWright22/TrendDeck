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
  // the reply it's in, while that reply is still being written it waits
  messageId: string | null
  at: number
  pinned: number
  visible: boolean
}

const entries = new Map<string, Entry>()
const requested = new Map<string, number>()
const subs = new Set<() => void>()
// replies your agent is still writing. a card in one waits until the reply is done, the editor you
// have open meanwhile stays where it is and shows the edits land; then the new one, under the
// reply's text, takes over
let writing: ReadonlySet<string> = new Set()
const waiting = (e: Entry): boolean => !!e.messageId && writing.has(e.messageId)

export function setWritingReplies(ids: ReadonlySet<string>): void {
  const before = [...entries.values()].filter(waiting)
  writing = ids
  const done = before.filter((e) => !waiting(e))
  // the reply is done: its editor takes over, the chat shows it
  for (const e of done) handedOver.add(e.id)
  if (done.length || [...entries.values()].some((e) => waiting(e) && !before.includes(e))) recompute()
}

// cards whose reply just finished, the chat scrolls to them once
const handedOver = new Set<string>()
export function takeHandover(id: string): boolean {
  return handedOver.delete(id)
}

// a card in a reply that's still being written
export function waitsForReply(id: string): boolean {
  const e = entries.get(id)
  return !!e && waiting(e)
}
let live: Set<string> = new Set()
let version = 0

function recompute(): void {
  const cands = [...entries.values()]
    // only the newest card on a file runs it, older ones point to that one
    .filter((e) => webSpec(e.appId) && !waiting(e) && newestOnDoc(e.id) === e.id)
    .map((e) => ({ id: e.id, key: `${e.appId}|${e.projectId}`, visible: e.visible, rank: Math.max(e.at, e.pinned) }))
  const next = pickLive(cands, live, liveMax())
  version += 1
  live = next
  for (const fn of subs) fn()
}

// how many editors run in the chat at once, Settings, Craft apps. each is a whole editor in memory
const LIVE_KEY = 'trenddeck.editorsAtOnce'
export const LIVE_CHOICES = [1, 2, 3, 4]

// the window's storage, none in tests
const store = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)

export function liveMax(): number {
  const n = Number(store()?.getItem(LIVE_KEY))
  return LIVE_CHOICES.includes(n) ? n : MAX_LIVE
}

export function setLiveMax(n: number): void {
  if (!LIVE_CHOICES.includes(n)) return
  store()?.setItem(LIVE_KEY, String(n))
  recompute()
}

// the newest card on the same document as this one. only that one shows the editor, older ones
// point to it
export function newestOnDoc(id: string): string {
  const e = entries.get(id)
  if (!e) return id
  // one still waiting for its reply doesn't count yet
  const same = [...entries.values()].filter((o) => o.appId === e.appId && o.projectId === e.projectId && !waiting(o))
  return same.length ? same.reduce((a, b) => (b.at > a.at ? b : a)).id : e.id
}

export function registerEmbed(id: string, appId: string, appName: string, projectId: string, at: number, messageId: string | null = null): () => void {
  entries.set(id, { id, appId, appName, projectId, messageId, at, pinned: requested.get(id) ?? entries.get(id)?.pinned ?? 0, visible: false })
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
