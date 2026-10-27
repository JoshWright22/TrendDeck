import { useState, type ReactNode } from 'react'
import type { Site } from '@shared/types'
import type { SiteHealth } from '@shared/inbox'
import { HealthDot } from '../pages/inbox/useInbox'
import { CloseIcon, PinIcon, PlusIcon } from '../components/Icons'

interface Props {
  sites: Site[]
  // opened from links, not saved
  temps: Site[]
  activeId: string | null
  onSelect: (id: string) => void
  onCloseTemp: (id: string) => void
  onKeepTemp: (id: string) => void
  onAdd: () => void
  // drag one tab onto another
  onMove: (fromId: string, toId: string) => void
  health?: Record<string, SiteHealth>
}

// the brand's sites as a row of tabs over the browser. reorder and remove live in Settings > Sites
export default function SiteStrip(props: Props): ReactNode {
  const { activeId, onSelect } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  return (
    <div className="ws-sitestrip" role="tablist" aria-label="Sites">
      {props.sites.map((s) => (
        <button
          key={s.id}
          role="tab"
          aria-selected={s.id === activeId}
          className={`ws-site${s.id === activeId ? ' on' : ''}${overId === s.id && dragId !== s.id ? ' drop' : ''}`}
          title="Drag to reorder"
          draggable
          onClick={() => onSelect(s.id)}
          onDragStart={(e) => {
            setDragId(s.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!dragId) return
            e.preventDefault()
            setOverId(s.id)
          }}
          onDragLeave={() => setOverId((o) => (o === s.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault()
            if (dragId && dragId !== s.id) props.onMove(dragId, s.id)
            setDragId(null)
            setOverId(null)
          }}
          onDragEnd={() => {
            setDragId(null)
            setOverId(null)
          }}
        >
          {props.health && <HealthDot state={props.health[s.id]?.state} />}
          {s.name}
        </button>
      ))}
      {props.temps.map((s) => (
        <span key={s.id} className={`ws-site temp${s.id === activeId ? ' on' : ''}`}>
          <button role="tab" aria-selected={s.id === activeId} onClick={() => onSelect(s.id)}>
            {s.name}
          </button>
          <button title="Keep as a site" aria-label={`Keep ${s.name}`} onClick={() => props.onKeepTemp(s.id)}>
            <PinIcon />
          </button>
          <button title="Close" aria-label={`Close ${s.name}`} onClick={() => props.onCloseTemp(s.id)}>
            <CloseIcon />
          </button>
        </span>
      ))}
      <button className="ws-site add" title="Add site" aria-label="Add site" onClick={props.onAdd}>
        <PlusIcon />
      </button>
    </div>
  )
}
