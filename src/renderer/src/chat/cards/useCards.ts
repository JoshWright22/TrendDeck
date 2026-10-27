import { useEffect, useState } from 'react'
import type { ChatCard } from '@shared/cards'
import type { Brand } from '@shared/types'
import type { Project } from '@shared/workspace'

// what every card gets from the chat
export interface CardActions {
  brand: Brand
  project: Project | undefined
  // to the agent: a steer while a reply runs, a new message otherwise
  sendToAgent: (text: string) => Promise<void>
  hasAgent: boolean
}

// the open thread's cards, kept current from cards:changed
export function useCards(brandId: string, threadId: string | null): ChatCard[] {
  const [cards, setCards] = useState<ChatCard[]>([])
  useEffect(() => {
    let alive = true
    setCards([])
    if (!threadId) return
    const api = window.trenddeckCards
    void api.list(brandId, threadId).then((list) => alive && setCards(list)).catch(() => {})
    const off = api.onChanged(({ brandId: b, card }) => {
      if (b !== brandId || card.threadId !== threadId) return
      setCards((list) => {
        const i = list.findIndex((c) => c.id === card.id)
        if (i < 0) return [...list, card]
        const next = list.slice()
        next[i] = card
        return next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [brandId, threadId])
  return cards
}

export const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
