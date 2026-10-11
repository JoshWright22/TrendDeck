// hands a drafted message to the chat composer. the chat pane might not be mounted
// yet when the draft is made, so it waits here until the pane takes it

let pending: string | null = null
const EVENT = 'trenddeck:chat-draft'

export function draftChat(text: string): void {
  pending = text
  window.dispatchEvent(new Event(EVENT))
}

export function takeDraft(): string | null {
  const t = pending
  pending = null
  return t
}

export function onDraft(fn: (text: string) => void): () => void {
  const listener = (): void => {
    const t = takeDraft()
    if (t) fn(t)
  }
  window.addEventListener(EVENT, listener)
  // one made before the pane opened
  listener()
  return () => window.removeEventListener(EVENT, listener)
}
