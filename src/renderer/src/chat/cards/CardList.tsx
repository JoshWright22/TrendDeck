import type { ReactNode } from 'react'
import type { ChatCard } from '@shared/cards'
import SuggestionCard from './SuggestionCard'
import { HistoryCard, StorageCard } from './StorageHistoryCards'
import VideoCard from './VideoCard'
import type { CardActions } from './useCards'
import './cards.css'

// the cards one reply's tools made, in the order they came
export default function CardList({ cards, a }: { cards: ChatCard[]; a: CardActions }): ReactNode {
  if (!cards.length) return null
  return (
    <div className="cx-cards">
      {cards.map((c) =>
        c.type === 'video' ? (
          <VideoCard key={c.id} card={c} a={a} />
        ) : c.type === 'suggestion' ? (
          <SuggestionCard key={c.id} card={c} a={a} />
        ) : c.type === 'storage' ? (
          <StorageCard key={c.id} card={c} />
        ) : (
          <HistoryCard key={c.id} card={c} a={a} />
        )
      )}
    </div>
  )
}
