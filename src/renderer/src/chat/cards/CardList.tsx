import type { ReactNode } from 'react'
import type { ChatCard } from '@shared/cards'
import { BrandFileCard, RuleCard } from './MemoryCards'
import ObsCard from './ObsCard'
import ScriptCard from './ScriptCard'
import SuggestionCard from './SuggestionCard'
import { HistoryCard, StorageCard } from './StorageHistoryCards'
import TakeCard from './TakeCard'
import VideoCard from './VideoCard'
import type { CardActions } from './useCards'
import './cards.css'
import './voice-cards.css'

function Card({ c, a }: { c: ChatCard; a: CardActions }): ReactNode {
  switch (c.type) {
    case 'video':
      return <VideoCard card={c} a={a} />
    case 'suggestion':
      return <SuggestionCard card={c} a={a} />
    case 'storage':
      return <StorageCard card={c} />
    case 'history':
      return <HistoryCard card={c} a={a} />
    case 'take':
      return <TakeCard card={c} a={a} />
    case 'script':
      return <ScriptCard card={c} a={a} />
    case 'rule':
      return <RuleCard card={c} a={a} />
    case 'brand-file':
      return <BrandFileCard card={c} a={a} />
    case 'obs':
      return <ObsCard card={c} a={a} />
  }
}

// the cards one reply's tools made, in the order they came
export default function CardList({ cards, a }: { cards: ChatCard[]; a: CardActions }): ReactNode {
  if (!cards.length) return null
  return (
    <div className="cx-cards">
      {cards.map((c) => (
        <Card key={c.id} c={c} a={a} />
      ))}
    </div>
  )
}
