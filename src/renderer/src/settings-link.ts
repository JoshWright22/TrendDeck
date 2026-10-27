// anything in the app can open Settings at a section, e.g. the composer's mic menu at Dictation
const EVENT = 'trenddeck:open-settings'

export function openSettings(section?: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: section }))
}

export function onOpenSettings(fn: (section?: string) => void): () => void {
  const listener = (e: Event): void => fn((e as CustomEvent<string | undefined>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
