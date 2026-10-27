import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { draftKey, DraftStore } from './draft-store'

// a second after you stop typing the draft goes to disk, not only to chromium's memory
let flush: number | undefined
const flushSoon = (): void => {
  clearTimeout(flush)
  flush = window.setTimeout(() => window.trenddeck?.flushDrafts?.(), 1000)
}

const store = new DraftStore({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    window.localStorage.setItem(key, value)
    flushSoon()
  },
  removeItem: (key) => {
    window.localStorage.removeItem(key)
    flushSoon()
  }
})

export function useChatDraft(brandId: string, threadId: string | null, projectId: string): [string, Dispatch<SetStateAction<string>>, boolean] {
  const key = draftKey(brandId, threadId, projectId)
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key])
  const snapshot = useCallback(() => store.get(key), [key])
  const { text, saved } = useSyncExternalStore(subscribe, snapshot)
  const setDraft = useCallback((update: SetStateAction<string>) => store.set(key, update), [key])
  return [text, setDraft, saved]
}
