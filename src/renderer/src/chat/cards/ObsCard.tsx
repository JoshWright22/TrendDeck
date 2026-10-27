import type { ReactNode } from 'react'
import type { ObsCard as Card } from '@shared/cards'
import { ObsPanel } from '../../workspace/obs/ObsWorkspace'
import type { CardActions } from './useCards'

// OBS in the chat: the same panel as the right pane, for this chat's project
export default function ObsCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const projectId = card.projectId ?? a.project?.id ?? null
  const project = a.brand.projects.find((p) => p.id === projectId)
  return (
    <article className="cx-card2" aria-label="OBS">
      <header className="cx-card2-head">
        <strong>OBS</strong>
        {project && <span className="muted">{project.name}</span>}
      </header>
      <ObsPanel brand={a.brand} projectId={projectId} threadId={card.threadId} />
    </article>
  )
}
