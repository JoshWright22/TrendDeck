import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { draftKey, DraftStore } from './draft-store'

const store = new DraftStore({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key)
})

export function useChatDraft(brandId: string, threadId: string | null, projectId: string): [string, Dispatch<SetStateAction<string>>, boolean] {
  const key = draftKey(brandId, threadId, projectId)
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key])
  const snapshot = useCallback(() => store.get(key), [key])
  const { text, saved } = useSyncExternalStore(subscribe, snapshot)
  const setDraft = useCallback((update: SetStateAction<string>) => store.set(key, update), [key])
  return [text, setDraft, saved]
}
