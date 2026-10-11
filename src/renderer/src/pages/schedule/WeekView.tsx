import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { Idea, ScheduleSlot } from '@shared/types'
import SlotChip, { grab, SLOT_TYPE } from './SlotChip'
import { atTime, fmtHour, fmtWeekday, minutesOf, sameDay, startOfDay, weekDays } from './dates'

interface Props {
  week: number
  slots: ScheduleSlot[]
  ideas: Map<string, Idea>
  onOpen: (id: string) => void
  onNew: (at: number) => void
  onMove: (id: string, at: number) => void
}

const HOUR_PX = 44
const CHIP_PX = 40
const SNAP = 15
const HOURS = Array.from({ length: 24 }, (_, h) => h)

// chips closer than a chip's height share the width side by side
function lanes(list: ScheduleSlot[]): Map<string, { lane: number; of: number }> {
  const out = new Map<string, { lane: number; of: number }>()
  const sorted = [...list].sort((a, b) => a.at - b.at)
  let group: ScheduleSlot[] = []
  let groupEnd = -1
  const flush = (): void => {
    const ends: number[] = []
    const picked: [string, number][] = []
    for (const s of group) {
      const top = (minutesOf(s.at) / 60) * HOUR_PX
      let lane = ends.findIndex((end) => end <= top)
      if (lane < 0) lane = ends.length
      ends[lane] = top + CHIP_PX
      picked.push([s.id, lane])
    }
    for (const [id, lane] of picked) out.set(id, { lane, of: ends.length })
    group = []
  }
  for (const s of sorted) {
    const top = (minutesOf(s.at) / 60) * HOUR_PX
    if (group.length && top >= groupEnd) flush()
    group.push(s)
    groupEnd = Math.max(groupEnd, top + CHIP_PX)
  }
  if (group.length) flush()
  return out
}

function minutesFromY(e: { clientY: number }, col: HTMLElement, offset: number): number {
  const y = e.clientY - col.getBoundingClientRect().top - offset
  const mins = Math.round(((y / HOUR_PX) * 60) / SNAP) * SNAP
  return Math.min(24 * 60 - SNAP, Math.max(0, mins))
}

export default function WeekView({ week, slots, ideas, onOpen, onNew, onMove }: Props): ReactNode {
  const days = useMemo(() => weekDays(week), [week])
  const scroller = useRef<HTMLDivElement>(null)
  const [ghost, setGhost] = useState<{ day: number; mins: number } | null>(null)
  const today = startOfDay(Date.now())

  // start the day around 8am instead of midnight
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR_PX * 8 - 10
  }, [])

  const byDay = useMemo(() => {
    const map = new Map<number, ScheduleSlot[]>()
    for (const d of days) map.set(d, [])
    for (const s of slots) map.get(startOfDay(s.at))?.push(s)
    return map
  }, [slots, days])

  const onDragOver = (e: DragEvent<HTMLDivElement>, day: number): void => {
    if (!e.dataTransfer.types.includes(SLOT_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const mins = minutesFromY(e, e.currentTarget, grab.offsetY)
    if (!ghost || ghost.day !== day || ghost.mins !== mins) setGhost({ day, mins })
  }

  const onDrop = (e: DragEvent<HTMLDivElement>, day: number): void => {
    e.preventDefault()
    setGhost(null)
    const id = e.dataTransfer.getData(SLOT_TYPE)
    if (id) onMove(id, atTime(day, minutesFromY(e, e.currentTarget, grab.offsetY)))
  }

  const onClick = (e: MouseEvent<HTMLDivElement>, day: number): void => {
    if (e.target !== e.currentTarget) return
    // a click picks the half hour under the mouse
    const mins = Math.floor(minutesFromY(e, e.currentTarget, 0) / 30) * 30
    onNew(atTime(day, mins))
  }

  return (
    <div className="sc-week">
      <div className="sc-week-head">
        <span />
        {days.map((d) => (
          <span key={d} className={sameDay(d, today) ? 'today' : ''}>
            {fmtWeekday(d)} <b>{new Date(d).getDate()}</b>
          </span>
        ))}
      </div>
      <div className="sc-week-body" ref={scroller}>
        <div className="sc-hours">
          {HOURS.map((h) => (
            <span key={h} style={{ height: HOUR_PX }}>
              {h > 0 ? fmtHour(h) : ''}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const list = byDay.get(day) ?? []
          const lane = lanes(list)
          return (
            <div
              key={day}
              className={`sc-wcol${sameDay(day, today) ? ' today' : ''}${day < today ? ' past' : ''}`}
              style={{ height: HOUR_PX * 24 }}
              title="Click to plan a post"
              onClick={(e) => onClick(e, day)}
              onDragOver={(e) => onDragOver(e, day)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGhost(null)
              }}
              onDrop={(e) => onDrop(e, day)}
            >
              {ghost?.day === day && (
                <div className="sc-ghost" style={{ top: (ghost.mins / 60) * HOUR_PX }} />
              )}
              {list.map((s) => {
                const l = lane.get(s.id) ?? { lane: 0, of: 1 }
                return (
                  <SlotChip
                    key={s.id}
                    slot={s}
                    idea={ideas.get(s.ideaId)}
                    onOpen={onOpen}
                    style={{
                      top: (minutesOf(s.at) / 60) * HOUR_PX,
                      height: CHIP_PX,
                      left: `calc(${(l.lane / l.of) * 100}% + 3px)`,
                      width: `calc(${100 / l.of}% - 6px)`
                    }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
