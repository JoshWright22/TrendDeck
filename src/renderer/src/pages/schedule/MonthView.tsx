import { useMemo, useState, type ReactNode } from 'react'
import type { Idea, ScheduleSlot } from '@shared/types'
import { PlusIcon } from '../../components/Icons'
import SlotChip, { SLOT_TYPE } from './SlotChip'
import { atTime, fmtWeekday, monthGrid, moveToDay, sameDay, startOfDay } from './dates'

interface Props {
  month: number
  slots: ScheduleSlot[]
  ideas: Map<string, Idea>
  defaultMinutes: number
  onOpen: (id: string) => void
  onNew: (at: number) => void
  onMove: (id: string, at: number) => void
  onDay: (day: number) => void
}

const MAX_SHOWN = 4

export default function MonthView({ month, slots, ideas, defaultMinutes, onOpen, onNew, onMove, onDay }: Props): ReactNode {
  const [over, setOver] = useState<number | null>(null)
  const days = useMemo(() => monthGrid(month), [month])
  const monthIndex = new Date(month).getMonth()
  const today = startOfDay(Date.now())

  const byDay = useMemo(() => {
    const map = new Map<number, ScheduleSlot[]>()
    for (const s of slots) {
      const key = startOfDay(s.at)
      const list = map.get(key)
      if (list) list.push(s)
      else map.set(key, [s])
    }
    for (const list of map.values()) list.sort((a, b) => a.at - b.at)
    return map
  }, [slots])

  const slotAt = (id: string): ScheduleSlot | undefined => slots.find((s) => s.id === id)

  return (
    <div className="sc-month">
      <div className="sc-weekdays">
        {days.slice(0, 7).map((d) => (
          <span key={d}>{fmtWeekday(d)}</span>
        ))}
      </div>
      <div className="sc-grid">
        {days.map((day) => {
          const list = byDay.get(day) ?? []
          const extra = list.length - MAX_SHOWN
          const cls = [
            'sc-day',
            new Date(day).getMonth() !== monthIndex ? 'out' : '',
            sameDay(day, today) ? 'today' : '',
            day < today ? 'past' : '',
            over === day ? 'over' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={day}
              className={cls}
              onDoubleClick={() => onNew(atTime(day, defaultMinutes))}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SLOT_TYPE)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (over !== day) setOver(day)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const id = e.dataTransfer.getData(SLOT_TYPE)
                const slot = id ? slotAt(id) : undefined
                if (slot) onMove(id, moveToDay(slot.at, day))
              }}
            >
              <div className="sc-day-head">
                <button className="sc-date" title="Open this week" onClick={() => onDay(day)}>
                  {new Date(day).getDate()}
                </button>
                <button
                  className="icon-btn small sc-add"
                  title="Plan a post on this day"
                  aria-label="Plan a post on this day"
                  onClick={() => onNew(atTime(day, defaultMinutes))}
                >
                  <PlusIcon />
                </button>
              </div>
              <div className="sc-day-slots">
                {list.slice(0, extra > 0 ? MAX_SHOWN - 1 : MAX_SHOWN).map((s) => (
                  <SlotChip key={s.id} slot={s} idea={ideas.get(s.ideaId)} compact onOpen={onOpen} />
                ))}
                {extra > 0 && (
                  <button className="sc-more" onClick={() => onDay(day)}>
                    +{extra + 1} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
