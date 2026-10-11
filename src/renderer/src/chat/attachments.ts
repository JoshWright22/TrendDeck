import type { Attachment } from '@shared/chat'

// other parts of the app (like the media library) hand files to the chat composer with
// attachToChat. anything with an id, name, type and size works, the rest gets dropped

const EVENT = 'trenddeck:chat-attach'

export function toAttachment(raw: unknown): Attachment | null {
  const o = raw as Partial<Attachment> | null
  if (!o || typeof o.name !== 'string' || !o.name) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : crypto.randomUUID(),
    name: o.name.slice(0, 200),
    type: typeof o.type === 'string' ? o.type.slice(0, 100) : '',
    size: typeof o.size === 'number' && o.size >= 0 ? o.size : 0
  }
}

export function attachToChat(items: unknown[]): void {
  const files = items.map(toAttachment).filter((a): a is Attachment => a !== null)
  if (files.length) window.dispatchEvent(new CustomEvent(EVENT, { detail: files }))
}

export function onAttach(fn: (files: Attachment[]) => void): () => void {
  const listener = (e: Event): void => fn((e as CustomEvent<Attachment[]>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

export function fileSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1000) return `${Math.round(n / 1000)} KB`
  return `${n} B`
}
