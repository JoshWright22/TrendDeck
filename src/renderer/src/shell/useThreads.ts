import { useCallback, useEffect, useState } from 'react'
import type { ThreadSummary } from '@shared/chat'
import { chat } from '../chat/api'

// the brand's chats for the sidebar, kept fresh from the chat events
export function useThreads(brandId: string | null): { threads: ThreadSummary[]; reload: () => void } {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const reload = useCallback(() => {
    if (!brandId) return
    void chat()
      .listThreads(brandId)
      .then((list) => setThreads(list))
  }, [brandId])

  useEffect(() => {
    setThreads([])
    reload()
  }, [reload])

  useEffect(() => {
    // a reply starting sends no threads event, so the first word of one marks it busy
    const live = new Set<string>()
    return chat().onEvent((ev) => {
      if (ev.brandId !== brandId) return
      if (ev.type === 'threads') return reload()
      if (ev.type === 'done') {
        live.delete(ev.threadId)
        return reload()
      }
      if (live.has(ev.threadId)) return
      live.add(ev.threadId)
      reload()
    })
  }, [brandId, reload])

  return { threads, reload }
}
