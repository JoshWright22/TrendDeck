import { useState, type ReactNode } from 'react'
import type { Site } from '@shared/types'
import { CloseIcon, PlusIcon } from './Icons'

interface Props {
  sites: Site[]
  activeId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMove: (fromId: string, toId: string) => void
  onAdd: () => void
}

export default function SiteTabs(props: Props): ReactNode {
  const { sites, activeId, onSelect, onRemove, onMove, onAdd } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  return (
    <div className="tabs" role="tablist">
      {sites.map((s) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={s.id === activeId}
          className={`tab${s.id === activeId ? ' active' : ''}${
            overId === s.id && dragId !== s.id ? ' drop' : ''
          }`}
          title={`${s.name} (drag to reorder)`}
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
          <span className="tab-name">{s.name}</span>
          <button
            className="tab-close"
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
      <button className="icon-btn" title="Add site" aria-label="Add site" onClick={onAdd}>
        <PlusIcon />
      </button>
    </div>
  )
}
