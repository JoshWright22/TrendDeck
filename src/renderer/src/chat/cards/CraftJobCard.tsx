import type { ReactNode } from 'react'
import type { CraftJobCard as Job } from '@shared/cards'
import { Spinner } from './StorageHistoryCards'
import type { CardActions } from './useCards'

// an export or proxy the native engine makes in the background for an editor in the chat
export default function CraftJobCard({ card, a }: { card: Job; a: CardActions }): ReactNode {
  const pct = card.progress === null ? null : Math.round(card.progress * 100)
  const state = card.state === 'running' ? (pct === null ? 'Working' : `Working, ${pct}%`) : card.state === 'done' ? 'Done' : 'Failed'
  return (
    <article className="cx-card2" aria-label={card.label}>
      <header className="cx-card2-head">
        <strong>
          {card.state === 'running' && <Spinner />}
          {card.label}
        </strong>
        <span className="muted">{state}</span>
      </header>
      {card.state === 'running' && (
        <div className="cx-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <div style={{ width: `${pct ?? 0}%` }} />
        </div>
      )}
      {card.state === 'done' && card.kind === 'export' && card.output?.kind === 'video' && (
        <video className="cx-job-video" controls preload="metadata" src={window.trenddeckCards.projectFileUrl(a.brand.id, card.output)} />
      )}
      {card.output && <p className="cx-card2-body muted">{card.output.file}</p>}
      {card.note && <p className={card.state === 'failed' ? 'cx-card2-error' : 'cx-card2-note'}>{card.note}</p>}
    </article>
  )
}
