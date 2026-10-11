import { useMemo, useState, type ReactNode } from 'react'
import { STAGE_NAMES, type Idea, type ScheduleSlot } from '@shared/types'
import { TrashIcon } from '../../components/Icons'
import { stageOf } from '../ideas/board'
import { fmtLongDay, fmtTime, platformClass, sameDay, slotTitle, startOfDay } from './dates'

interface Props {
  slots: ScheduleSlot[]
  ideas: Map<string, Idea>
  onOpen: (id: string) => void
  onToggleDone: (id: string) => void
  onDelete: (id: string) => void
}

export default function ListView({ slots, ideas, onOpen, onToggleDone, onDelete }: Props): ReactNode {
  const [showPast, setShowPast] = useState(false)
  const today = startOfDay(Date.now())

  const groups = useMemo(() => {
    const list = slots
      .filter((s) => showPast || s.at >= today)
      .sort((a, b) => (showPast ? b.at - a.at : a.at - b.at))
    const out: { day: number; slots: ScheduleSlot[] }[] = []
    for (const s of list) {
      const day = startOfDay(s.at)
      const last = out[out.length - 1]
      if (last && last.day === day) last.slots.push(s)
      else out.push({ day, slots: [s] })
    }
    return out
  }, [slots, showPast, today])

  const pastCount = slots.filter((s) => s.at < today).length

  return (
    <div className="scroll sc-list">
      <div className="sc-list-bar">
        <button className={`filter-chip${!showPast ? ' on' : ''}`} onClick={() => setShowPast(false)}>
          Coming up
        </button>
        <button className={`filter-chip${showPast ? ' on' : ''}`} onClick={() => setShowPast(true)}>
          Everything <span className="n">{slots.length}</span>
        </button>
        {!showPast && pastCount > 0 && <span className="muted small">{pastCount} in the past hidden</span>}
      </div>
      {groups.length === 0 && (
        <p className="feed-empty">
          {showPast ? 'Nothing planned yet.' : 'Nothing coming up. Double click a day in Month to plan a post.'}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.day} className="sc-list-day">
          <h3 className={sameDay(g.day, today) ? 'today' : ''}>
            {sameDay(g.day, today) ? 'Today' : fmtLongDay(g.day)}
          </h3>
          <ul>
            {g.slots.map((s) => {
              const idea = ideas.get(s.ideaId)
              return (
                <li key={s.id} className={`sc-row ${platformClass(s.platform)}${s.done ? ' done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={s.done}
                    title={s.done ? 'Posted' : 'Mark as posted'}
                    aria-label="Posted"
                    onChange={() => onToggleDone(s.id)}
                  />
                  <span className="sc-row-time">{fmtTime(s.at)}</span>
                  <span className="sc-row-pf">
                    <span className="sc-pf" />
                    {s.platform}
                  </span>
                  <button className="sc-row-main" onClick={() => onOpen(s.id)}>
                    <span className="sc-row-title">{slotTitle(s, idea)}</span>
                    <span className="muted small sc-row-sub">
                      {idea
                        ? `Idea: ${STAGE_NAMES[stageOf(idea)]}`
                        : s.ideaId
                          ? 'Idea deleted'
                          : 'No idea linked'}
                      {', '}
                      {s.draft ? s.draft.split('\n')[0].slice(0, 90) : 'no draft yet'}
                    </span>
                  </button>
                  <button
                    className="icon-btn small"
                    title="Delete"
                    aria-label={`Delete ${slotTitle(s, idea)}`}
                    onClick={() => onDelete(s.id)}
                  >
                    <TrashIcon />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
