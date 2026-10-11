import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { PLATFORMS, type Brand, type ScheduleSlot } from '@shared/types'
import PageHeader from '../../components/PageHeader'
import { BackIcon, ForwardIcon, PlusIcon } from '../../components/Icons'
import type { PageProps } from '../types'
import { UndoToast, useUndo } from '../ideas/UndoToast'
import { newId } from '../ideas/board'
import MonthView from './MonthView'
import WeekView from './WeekView'
import ListView from './ListView'
import SlotEditor from './SlotEditor'
import {
  addDays,
  addMonths,
  atTime,
  fmtMonth,
  fmtShort,
  slotTitle,
  startOfDay,
  startOfMonth,
  startOfWeek
} from './dates'
import '../ideas/planner.css'
import './schedule.css'

type Mode = 'month' | 'week' | 'list'

const MODES: { id: Mode; name: string }[] = [
  { id: 'month', name: 'Month' },
  { id: 'week', name: 'Week' },
  { id: 'list', name: 'List' }
]

// new posts default to 5pm
const DEFAULT_MINUTES = 17 * 60

// kept while the app runs so switching pages doesn't reset the view
let lastMode: Mode = 'month'

export default function SchedulePage({ brand, editBrand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const [mode, setModeState] = useState<Mode>(lastMode)
  const [cursor, setCursor] = useState(() => startOfDay(Date.now()))
  const [platform, setPlatform] = useState('all')
  const [editing, setEditing] = useState<{ slot: ScheduleSlot; isNew: boolean } | null>(null)
  const { pending, offer, run, dismiss } = useUndo()

  const setMode = (m: Mode): void => {
    lastMode = m
    setModeState(m)
  }

  const edit = useRef(editBrand)
  edit.current = editBrand
  const all = useMemo(() => brand.schedule ?? [], [brand.schedule])
  const allRef = useRef(all)
  allRef.current = all
  const setSlots = useCallback((fn: (slots: ScheduleSlot[]) => ScheduleSlot[]) => {
    edit.current((b: Brand) => ({ ...b, schedule: fn(b.schedule ?? []) }))
  }, [])

  const ideas = useMemo(() => new Map(brand.ideas.map((i) => [i.id, i])), [brand.ideas])
  const slots = useMemo(
    () => (platform === 'all' ? all : all.filter((s) => s.platform === platform)),
    [all, platform]
  )
  // platforms in use that aren't in the fixed list still show up in the filter
  const platforms = useMemo(
    () => [...new Set([...PLATFORMS, ...all.map((s) => s.platform)])],
    [all]
  )

  const open = useCallback((id: string) => {
    const slot = allRef.current.find((s) => s.id === id)
    if (slot) setEditing({ slot, isNew: false })
  }, [])

  const create = useCallback(
    (at: number) => {
      setEditing({
        slot: {
          id: newId(),
          at,
          platform: platform === 'all' ? 'YouTube' : platform,
          title: '',
          ideaId: '',
          draft: '',
          done: false
        },
        isNew: true
      })
    },
    [platform]
  )

  const move = useCallback(
    (id: string, at: number) => setSlots((list) => list.map((s) => (s.id === id ? { ...s, at } : s))),
    [setSlots]
  )

  const remove = useCallback(
    (id: string) => {
      const gone = allRef.current.find((s) => s.id === id)
      if (!gone) return
      setSlots((list) => list.filter((s) => s.id !== id))
      setEditing(null)
      const title = slotTitle(gone, ideas.get(gone.ideaId))
      offer({
        label: `Deleted "${title.length > 40 ? `${title.slice(0, 40)}...` : title}"`,
        undo: () => setSlots((list) => (list.some((s) => s.id === id) ? list : [...list, gone]))
      })
    },
    [setSlots, offer, ideas]
  )

  const toggleDone = useCallback(
    (id: string) => setSlots((list) => list.map((s) => (s.id === id ? { ...s, done: !s.done } : s))),
    [setSlots]
  )

  const step = (dir: -1 | 1): void =>
    setCursor((c) => (mode === 'week' ? addDays(c, dir * 7) : addMonths(c, dir)))

  const label =
    mode === 'week'
      ? `${fmtShort(startOfWeek(cursor))} to ${fmtShort(addDays(startOfWeek(cursor), 6))}`
      : fmtMonth(startOfMonth(cursor))

  return (
    <div className="page">
      <PageHeader title="Schedule" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <div className="sc-modes" role="tablist" aria-label="View">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={mode === m.id ? 'on' : ''}
              onClick={() => setMode(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
        {mode !== 'list' && (
          <div className="sc-nav">
            <button className="icon-btn small" aria-label="Back" onClick={() => step(-1)}>
              <BackIcon />
            </button>
            <button className="btn ghost sc-today" onClick={() => setCursor(startOfDay(Date.now()))}>
              Today
            </button>
            <button className="icon-btn small" aria-label="Forward" onClick={() => step(1)}>
              <ForwardIcon />
            </button>
            <span className="sc-label">{label}</span>
          </div>
        )}
        <select value={platform} aria-label="Platform" onChange={(e) => setPlatform(e.target.value)}>
          <option value="all">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button className="pill teal" onClick={() => create(atTime(cursor, DEFAULT_MINUTES))}>
          <PlusIcon />
          Plan a post
        </button>
      </PageHeader>

      <div className="sc-body" key={mode}>
        {mode === 'month' && (
          <MonthView
            month={cursor}
            slots={slots}
            ideas={ideas}
            defaultMinutes={DEFAULT_MINUTES}
            onOpen={open}
            onNew={create}
            onMove={move}
            onDay={(day) => {
              setCursor(day)
              setMode('week')
            }}
          />
        )}
        {mode === 'week' && (
          <WeekView week={cursor} slots={slots} ideas={ideas} onOpen={open} onNew={create} onMove={move} />
        )}
        {mode === 'list' && (
          <ListView slots={slots} ideas={ideas} onOpen={open} onToggleDone={toggleDone} onDelete={remove} />
        )}
      </div>

      {editing && (
        <SlotEditor
          key={editing.slot.id}
          slot={editing.slot}
          isNew={editing.isNew}
          ideas={brand.ideas}
          onClose={() => setEditing(null)}
          onDelete={() => remove(editing.slot.id)}
          onSave={(slot) => {
            setSlots((list) =>
              list.some((s) => s.id === slot.id) ? list.map((s) => (s.id === slot.id ? slot : s)) : [...list, slot]
            )
            setEditing(null)
          }}
        />
      )}

      <UndoToast pending={pending} onUndo={run} onDismiss={dismiss} />
    </div>
  )
}
