export interface DraftSnapshot {
  text: string
  saved: boolean
}

export function draftKey(brandId: string, threadId: string | null, projectId: string): string {
  return `trenddeck.chat-draft.v1:${encodeURIComponent(brandId)}:${threadId ? `thread:${encodeURIComponent(threadId)}` : `new:${encodeURIComponent(projectId)}`}`
}

export class DraftStore {
  private drafts = new Map<string, DraftSnapshot>()
  private listeners = new Map<string, Set<() => void>>()

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  get(key: string): DraftSnapshot {
    const cached = this.drafts.get(key)
    if (cached) return cached
    let snapshot: DraftSnapshot
    try { snapshot = { text: this.storage.getItem(key) ?? '', saved: true } }
    catch { snapshot = { text: '', saved: false } }
    this.drafts.set(key, snapshot)
    return snapshot
  }

  set(key: string, update: string | ((text: string) => string)): void {
    const text = typeof update === 'function' ? update(this.get(key).text) : update
    let saved = true
    try {
      if (text) this.storage.setItem(key, text)
      else this.storage.removeItem(key)
    } catch { saved = false }
    this.drafts.set(key, { text, saved })
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }
}
