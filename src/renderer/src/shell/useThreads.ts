import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadSummary } from '@shared/chat'
import { chat } from '../chat/api'

// every brand's chats for the sidebar, newest first, kept fresh from the chat events
export function useThreads(brandIds: string[]): { byBrand: Record<string, ThreadSummary[]>; reload: (brandId: string) => void } {
  const [byBrand, setByBrand] = useState<Record<string, ThreadSummary[]>>({})
  const sequence = useRef<Record<string, number>>({})
  const key = brandIds.join(',')

  const reload = useCallback((brandId: string) => {
    const request = (sequence.current[brandId] = (sequence.current[brandId] ?? 0) + 1)
    void chat()
      .listThreads(brandId)
      .then((list) => {
        if (sequence.current[brandId] !== request) return
        setByBrand((all) => ({ ...all, [brandId]: [...list].sort((a, b) => b.updatedAt - a.updatedAt) }))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const ids = key.split(',').filter(Boolean)
    setByBrand((all) => Object.fromEntries(ids.map((id) => [id, all[id] ?? []])))
    for (const id of ids) reload(id)
  }, [key, reload])

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const off = chat().onEvent((ev) => {
      if (!key.split(',').includes(ev.brandId)) return
      const pending = timers.get(ev.brandId)
      if (ev.type === 'threads' || ev.type === 'done') {
        if (pending) clearTimeout(pending)
        timers.delete(ev.brandId)
        return reload(ev.brandId)
      }
      // streaming text comes in fast, the list only needs a refresh now and then
      if (!pending) timers.set(ev.brandId, setTimeout(() => { timers.delete(ev.brandId); reload(ev.brandId) }, 350))
    })
    return () => {
      off()
      for (const t of timers.values()) clearTimeout(t)
    }
  }, [key, reload])

  return { byBrand, reload }
}
