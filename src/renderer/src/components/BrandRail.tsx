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

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  // one word gets one letter, it has to fit on a small card
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

const mod = navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl'

export default function BrandRail({ brands, activeId, onSelect, onEdit, onAdd }: Props): ReactNode {
  return (
    <nav className="rail" aria-label="Brands">
      {brands.map((b, i) => (
        <button
          key={b.id}
          className={`brand-icon${b.id === activeId ? ' active' : ''}`}
          title={`${b.name}${i < 9 ? ` (${mod}+${i + 1})` : ''}, right click to edit`}
          aria-pressed={b.id === activeId}
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
