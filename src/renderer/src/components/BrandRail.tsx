import type { ReactNode } from 'react'
import type { Brand } from '@shared/types'
import { PlusIcon } from './Icons'

interface Props {
  brands: Brand[]
  activeId: string | null
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onAdd: () => void
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export default function BrandRail({ brands, activeId, onSelect, onEdit, onAdd }: Props): ReactNode {
  return (
    <nav className="rail panel" aria-label="Brands">
      {brands.map((b) => (
        <button
          key={b.id}
          className={`brand-icon${b.id === activeId ? ' active' : ''}`}
          title={`${b.name} (right click to edit)`}
          onClick={() => onSelect(b.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            onEdit(b.id)
          }}
        >
          {initials(b.name)}
        </button>
      ))}
      <button className="brand-icon add" title="Add brand" aria-label="Add brand" onClick={onAdd}>
        <PlusIcon />
      </button>
    </nav>
  )
}
