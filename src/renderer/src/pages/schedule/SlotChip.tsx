import { memo, type CSSProperties, type ReactNode } from 'react'
import type { Idea, ScheduleSlot } from '@shared/types'
import { fmtTime, platformClass, slotTitle } from './dates'

export const SLOT_TYPE = 'text/x-trenddeck-slot'

// where in the chip the drag started, so a week drop lands where the chip top is
export const grab = { offsetY: 0 }

interface Props {
  slot: ScheduleSlot
  idea: Idea | undefined
  compact?: boolean
  style?: CSSProperties
  onOpen: (id: string) => void
}

function SlotChip({ slot, idea, compact, style, onOpen }: Props): ReactNode {
  const title = slotTitle(slot, idea)
  const tip = [
    `${fmtTime(slot.at)} ${slot.platform}`,
    title,
    idea && slot.title.trim() ? `Idea: ${idea.title}` : '',
    slot.ideaId && !idea ? 'Linked idea was deleted' : '',
    slot.draft ? 'Has a draft' : 'No draft yet',
    slot.done ? 'Posted' : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      className={`sc-chip ${platformClass(slot.platform)}${slot.done ? ' done' : ''}${compact ? ' compact' : ''}`}
      style={style}
      draggable
      title={tip}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(slot.id)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.stopPropagation()
        grab.offsetY = e.clientY - e.currentTarget.getBoundingClientRect().top
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(SLOT_TYPE, slot.id)
      }}
    >
      <span className="sc-pf" />
      <span className="sc-time">{fmtTime(slot.at)}</span>
      <span className="sc-title">{title}</span>
      {!compact && (
        <span className="sc-meta">
          {slot.platform}
          {slot.draft ? ', draft' : ''}
        </span>
      )}
    </button>
  )
}

export default memo(SlotChip)
