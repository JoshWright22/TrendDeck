import type { ReactNode } from 'react'
import type { SettingsCard as Card } from '@shared/cards'
import { openSettings } from '../../settings-link'

// the agent asking you to do something in Settings it can't do for you: why, and the way there
export default function SettingsCard({ card }: { card: Card }): ReactNode {
  return (
    <article className="cx-card2" aria-label={`Settings, ${card.section}`}>
      <header className="cx-card2-head">
        <strong>Settings</strong>
        <span className="muted">{card.section}</span>
      </header>
      {card.why && <p className="cx-card2-body">{card.why}</p>}
      <div className="cx-card2-actions">
        <button type="button" className="primary" onClick={() => openSettings(card.section)}>
          Open Settings, {card.section}
        </button>
      </div>
    </article>
  )
}
