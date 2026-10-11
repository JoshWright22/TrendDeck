import { useState, type ReactNode } from 'react'
import type { Site } from '@shared/types'
import type { SiteHealth } from '@shared/inbox'
import { HealthDot } from '../pages/inbox/useInbox'
import { CloseIcon, PinIcon, PlusIcon } from './Icons'

interface Props {
  sites: Site[]
  // opened from links, not saved
  temps: Site[]
  onCloseTemp: (id: string) => void
  onKeepTemp: (id: string) => void
  activeId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMove: (fromId: string, toId: string) => void
  onAdd: () => void
  // login state per site id, from the inbox
  health?: Record<string, SiteHealth>
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// the sidebar's site list, drag a row onto another to reorder
export default function SiteTabs(props: Props): ReactNode {
  const { sites, activeId, onSelect, onRemove, onMove, onAdd } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  return (
    <section className="side-section" aria-label="Sites">
      <div className="side-label">
        <span>Sites</span>
        <button className="icon-btn small" title="Add site" aria-label="Add site" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <div className="site-list" role="list">
        {sites.map((s) => (
          <div
            key={s.id}
            role="listitem"
            className={`side-item site-row${s.id === activeId ? ' active' : ''}${
              overId === s.id && dragId !== s.id ? ' drop' : ''
            }`}
            title={`${host(s.url)} (drag to reorder)`}
            tabIndex={0}
            draggable
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(s.id)
              }
            }}
            onDragStart={(e) => {
              setDragId(s.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              setOverId(s.id)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== s.id) onMove(dragId, s.id)
              setDragId(null)
              setOverId(null)
            }}
            onDragEnd={() => {
              setDragId(null)
              setOverId(null)
            }}
          >
            <span className="site-dot">{s.name.slice(0, 1).toUpperCase()}</span>
            <span className="side-name">{s.name}</span>
            {props.health && <HealthDot state={props.health[s.id]?.state} />}
            <button
              className="row-close"
              title={`Remove ${s.name}`}
              aria-label={`Remove ${s.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(s.id)
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        {sites.length === 0 && props.temps.length === 0 && <p className="side-empty">No sites yet</p>}
        {props.temps.map((s) => (
          <div
            key={s.id}
            role="listitem"
            className={`side-item site-row temp${s.id === activeId ? ' active' : ''}`}
            title={`${s.name}, open until you close the app`}
            tabIndex={0}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(s.id)
              }
            }}
          >
            <span className="site-dot">{s.name.slice(0, 1).toUpperCase()}</span>
            <span className="side-name">{s.name}</span>
            <button
              className="row-close"
              title="Keep as a site"
              aria-label={`Keep ${s.name} as a site`}
              onClick={(e) => {
                e.stopPropagation()
                props.onKeepTemp(s.id)
              }}
            >
              <PinIcon />
            </button>
            <button
              className="row-close"
              title="Close tab"
              aria-label={`Close ${s.name}`}
              onClick={(e) => {
                e.stopPropagation()
                props.onCloseTemp(s.id)
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
