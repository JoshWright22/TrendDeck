import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadSummary } from '@shared/chat'
import { chat } from '../chat/api'

// the brand's chats for the sidebar, kept fresh from the chat events
export function useThreads(brandId: string | null): { threads: ThreadSummary[]; reload: () => void } {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const currentBrand = useRef(brandId)
  const sequence = useRef(0)
  currentBrand.current = brandId
  const reload = useCallback(() => {
    if (!brandId) return
    const request = ++sequence.current
    void chat()
      .listThreads(brandId)
      .then((list) => { if (currentBrand.current === brandId && sequence.current === request) setThreads(list) })
      .catch(() => {})
  }, [brandId])

  useEffect(() => {
    setThreads([])
    reload()
  }, [reload])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = chat().onEvent((ev) => {
      if (ev.brandId !== brandId) return
      if (ev.type === 'threads' || ev.type === 'done') {
        if (timer) clearTimeout(timer)
        timer = null
        return reload()
      }
      if (!timer) timer = setTimeout(() => { timer = null; reload() }, 350)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [brandId, reload])

  return { threads, reload }
}
