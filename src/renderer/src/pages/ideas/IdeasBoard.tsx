import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { IDEA_STAGES, STAGE_NAMES, type Brand, type Idea, type IdeaStage } from '@shared/types'
import PageHeader from '../../components/PageHeader'
import { CloseIcon, PlusIcon, SearchIcon } from '../../components/Icons'
import type { PageProps } from '../types'
import IdeaCard from './IdeaCard'
import IdeaEditor from './IdeaEditor'
import { UndoToast, useUndo } from './UndoToast'
import { addIdea, makeIdea, matches, moveIdea, stageOf } from './board'
import './planner.css'
import './ideas.css'

type Drop = { stage: IdeaStage; beforeId: string | null }

const POP_MS = 700

export default function IdeasBoard({ brand, editBrand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<IdeaStage | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [popping, setPopping] = useState<Record<string, true>>({})
  const { pending, offer, run, dismiss } = useUndo()

  // the card handlers stay the same between renders so memo'd cards don't redraw
  const edit = useRef(editBrand)
  edit.current = editBrand
  const ideasRef = useRef(brand.ideas)
  ideasRef.current = brand.ideas
  const setIdeas = useCallback((fn: (ideas: Idea[]) => Idea[]) => {
    edit.current((b: Brand) => ({ ...b, ideas: fn(b.ideas) }))
  }, [])

  const popTimers = useRef<number[]>([])
  useEffect(() => () => popTimers.current.forEach((t) => window.clearTimeout(t)), [])
  const pop = useCallback((id: string) => {
    setPopping((p) => ({ ...p, [id]: true }))
    popTimers.current.push(
      window.setTimeout(() => {
        setPopping((p) => {
          const next = { ...p }
          delete next[id]
          return next
        })
      }, POP_MS)
    )
  }, [])

  const move = useCallback(
    (id: string, stage: IdeaStage, beforeId: string | null) => {
      const was = ideasRef.current.find((i) => i.id === id)
      if (!was) return
      setIdeas((ideas) => moveIdea(ideas, id, stage, beforeId))
      if (stage === 'posted' && stageOf(was) !== 'posted') pop(id)
    },
    [setIdeas, pop]
  )

  const shift = useCallback(
    (id: string, dir: -1 | 1) => {
      const idea = ideasRef.current.find((i) => i.id === id)
      if (!idea) return
      const at = IDEA_STAGES.indexOf(stageOf(idea)) + dir
      if (at < 0 || at >= IDEA_STAGES.length) return
      move(id, IDEA_STAGES[at], null)
      // keep focus on the card after it jumps columns
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-idea="${id}"] .ib-card`)?.focus()
      )
    },
    [move]
  )

  const remove = useCallback(
    (id: string) => {
      const ideas = ideasRef.current
      const at = ideas.findIndex((i) => i.id === id)
      if (at < 0) return
      const gone = ideas[at]
      setIdeas((list) => list.filter((i) => i.id !== id))
      setEditing((e) => (e === id ? null : e))
      offer({
        label: `Deleted "${gone.title.length > 40 ? `${gone.title.slice(0, 40)}...` : gone.title}"`,
        undo: () =>
          setIdeas((list) => {
            if (list.some((i) => i.id === id)) return list
            const next = [...list]
            next.splice(Math.min(at, next.length), 0, gone)
            return next
          })
      })
    },
    [setIdeas, offer]
  )

  const onTag = useCallback((tag: string) => setQuery(`#${tag}`), [])
  const onDragStart = useCallback((id: string) => setDragId(id), [])
  const onDragEnd = useCallback(() => {
    setDragId(null)
    setDrop(null)
  }, [])

  // top half of a card drops before it, bottom half before the next one
  const onDragOverCard = useCallback((e: DragEvent<HTMLElement>, id: string) => {
    if (!e.dataTransfer.types.includes('text/x-trenddeck-idea')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const ideas = ideasRef.current
    const idea = ideas.find((i) => i.id === id)
    if (!idea) return
    const stage = stageOf(idea)
    const box = e.currentTarget.getBoundingClientRect()
    let beforeId: string | null = id
    if (e.clientY > box.top + box.height / 2) {
      const col = ideas.filter((i) => stageOf(i) === stage)
      beforeId = col[col.indexOf(idea) + 1]?.id ?? null
    }
    setDrop((d) => (d && d.stage === stage && d.beforeId === beforeId ? d : { stage, beforeId }))
  }, [])

  const onDropColumn = (e: DragEvent<HTMLElement>, stage: IdeaStage): void => {
    const id = e.dataTransfer.getData('text/x-trenddeck-idea') || dragId
    e.preventDefault()
    if (id) move(id, stage, drop && drop.stage === stage ? drop.beforeId : null)
    setDragId(null)
    setDrop(null)
  }

  const submitAdd = (stage: IdeaStage): void => {
    const title = draft.trim()
    if (!title) return
    const idea = makeIdea(title, stage)
    setIdeas((ideas) => addIdea(ideas, idea))
    if (stage === 'posted') pop(idea.id)
    setDraft('')
  }

  const slotCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of brand.schedule ?? []) if (s.ideaId) counts[s.ideaId] = (counts[s.ideaId] ?? 0) + 1
    return counts
  }, [brand.schedule])

  const columns = useMemo(() => {
    const cols = Object.fromEntries(IDEA_STAGES.map((s) => [s, [] as Idea[]])) as Record<IdeaStage, Idea[]>
    for (const idea of brand.ideas) if (matches(idea, query)) cols[stageOf(idea)].push(idea)
    return cols
  }, [brand.ideas, query])

  const shown = IDEA_STAGES.reduce((n, s) => n + columns[s].length, 0)
  const open = editing ? brand.ideas.find((i) => i.id === editing) : undefined

  return (
    <div className="page">
      <PageHeader title="Ideas" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <span className="muted small ib-count">
          {query ? `${shown} of ${brand.ideas.length}` : brand.ideas.length}
        </span>
        <label className="search">
          <SearchIcon />
          <input
            value={query}
            placeholder="Search, or #tag"
            aria-label="Search ideas"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          {query && (
            <button className="pl-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <CloseIcon />
            </button>
          )}
        </label>
        <button
          className="pill teal"
          onClick={() => {
            setDraft('')
            setAdding('idea')
          }}
        >
          <PlusIcon />
          New idea
        </button>
      </PageHeader>

      <div className="ib-board">
        {IDEA_STAGES.map((stage) => {
          const cards = columns[stage]
          const over = drop?.stage === stage
          return (
            <section
              key={stage}
              className={`ib-col${over ? ' over' : ''}`}
              aria-label={STAGE_NAMES[stage]}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/x-trenddeck-idea')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (!over) setDrop({ stage, beforeId: null })
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
              }}
              onDrop={(e) => onDropColumn(e, stage)}
            >
              <header className="ib-col-head">
                <span className={`ib-dot st-${stage}`} />
                <h3>{STAGE_NAMES[stage]}</h3>
                <span className="count">{cards.length}</span>
                <span className="spacer" />
                <button
                  className="icon-btn small"
                  title={`Add to ${STAGE_NAMES[stage]}`}
                  aria-label={`Add to ${STAGE_NAMES[stage]}`}
                  onClick={() => {
                    setDraft('')
                    setAdding(adding === stage ? null : stage)
                  }}
                >
                  <PlusIcon />
                </button>
              </header>

              <div className="ib-cards">
                {adding === stage && (
                  <form
                    className="ib-quick"
                    onSubmit={(e) => {
                      e.preventDefault()
                      submitAdd(stage)
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      maxLength={300}
                      placeholder="Title, then Enter"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setAdding(null)
                      }}
                      onBlur={() => !draft.trim() && setAdding(null)}
                    />
                  </form>
                )}
                {cards.map((idea, n) => (
                  <div key={idea.id} className="ib-slot" data-idea={idea.id}>
                    {over && drop?.beforeId === idea.id && <div className="ib-drop-line" />}
                    <IdeaCard
                      idea={idea}
                      index={n}
                      popping={!!popping[idea.id]}
                      dragging={dragId === idea.id}
                      slots={slotCounts[idea.id] ?? 0}
                      onOpen={setEditing}
                      onDelete={remove}
                      onShift={shift}
                      onTag={onTag}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onDragOverCard={onDragOverCard}
                    />
                  </div>
                ))}
                {over && drop?.beforeId === null && <div className="ib-drop-line" />}
                {cards.length === 0 && adding !== stage && (
                  <p className="ib-empty">
                    {query
                      ? 'Nothing matches'
                      : stage === 'idea'
                        ? 'Save a trend or hit + to write one down'
                        : 'Drag a card here'}
                  </p>
                )}
              </div>
            </section>
          )
        })}
      </div>

      {open && (
        <IdeaEditor
          key={open.id}
          idea={open}
          slots={(brand.schedule ?? []).filter((s) => s.ideaId === open.id)}
          onClose={() => setEditing(null)}
          onDelete={() => remove(open.id)}
          onSave={(next) => {
            const was = stageOf(open)
            setIdeas((ideas) =>
              stageOf(next) === was
                ? ideas.map((i) => (i.id === next.id ? next : i))
                : moveIdea(
                    ideas.map((i) => (i.id === next.id ? { ...next, stage: was } : i)),
                    next.id,
                    stageOf(next),
                    null
                  )
            )
            if (stageOf(next) === 'posted' && was !== 'posted') pop(next.id)
            setEditing(null)
          }}
        />
      )}

      <UndoToast pending={pending} onUndo={run} onDismiss={dismiss} />
    </div>
  )
}
