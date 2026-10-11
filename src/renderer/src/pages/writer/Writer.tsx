import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  WRITER_PLATFORMS,
  type Draft,
  type Idea,
  type PlatformDraft,
  type WriterPlatform
} from '@shared/types'
import PageHeader from '../../components/PageHeader'
import { PlusIcon, TrashIcon } from '../../components/Icons'
import type { PageProps } from '../types'
import { useDrafts } from './useDrafts'
import { CardCorners } from './Mark'
import { PLATFORMS, SPEC, hasContent, platformFit } from './platforms'
import Editor from './Editor'
import './writer.css'

const newId = (): string => crypto.randomUUID()

function emptyPlatform(): PlatformDraft {
  return { fields: {}, thread: [''], versions: [] }
}

function newDraft(idea: Idea | null): Draft {
  const now = Date.now()
  const platforms = Object.fromEntries(WRITER_PLATFORMS.map((p) => [p, emptyPlatform()])) as Record<
    WriterPlatform,
    PlatformDraft
  >
  // the idea title is a decent first post title
  if (idea) {
    platforms.youtube.fields.title = idea.title.slice(0, 100)
    platforms.reddit.fields.title = idea.title.slice(0, 300)
  }
  return {
    id: newId(),
    ideaId: idea?.id ?? null,
    title: idea?.title ?? 'Untitled draft',
    createdAt: now,
    updatedAt: now,
    platforms
  }
}

function NewDraftMenu(props: { ideas: Idea[]; onPick: (idea: Idea | null) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const pick = (idea: Idea | null): void => {
    setOpen(false)
    props.onPick(idea)
  }
  return (
    <div className="wr-menu-wrap" ref={ref}>
      <button className="wr-card wr-new" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <PlusIcon />
        <span>New draft</span>
      </button>
      {open && (
        <div className="wr-menu" role="menu">
          <button role="menuitem" onClick={() => pick(null)}>
            Blank draft
          </button>
          {props.ideas.length > 0 && <div className="wr-menu-label">From an idea</div>}
          {props.ideas.map((idea) => (
            <button role="menuitem" key={idea.id} title={idea.title} onClick={() => pick(idea)}>
              {idea.title}
            </button>
          ))}
          {props.ideas.length === 0 && (
            <p className="wr-menu-note">No saved ideas yet. Save some from Trends or Ideas.</p>
          )}
        </div>
      )}
    </div>
  )
}

function DraftCard(props: { draft: Draft; active: boolean; index: number; onPick: () => void }): ReactNode {
  const { draft } = props
  const filled = WRITER_PLATFORMS.filter((p) => hasContent(draft.platforms[p]))
  const over = WRITER_PLATFORMS.some((p) => platformFit(SPEC[p], draft.platforms[p]) === 'over')
  return (
    <button
      className={`wr-card${props.active ? ' active' : ''}`}
      style={{ animationDelay: `${Math.min(props.index, 10) * 35}ms` }}
      onClick={props.onPick}
      aria-pressed={props.active}
      title={draft.title}
    >
      <CardCorners tone={over ? 'pink' : 'teal'} />
      <span className="wr-card-title">{draft.title || 'Untitled draft'}</span>
      <span className="wr-card-foot">
        {filled.length === 0 ? 'Empty' : filled.map((p) => SPEC[p].name).join(', ')}
      </span>
    </button>
  )
}

export default function Writer({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const { doc, update } = useDrafts(brand.id)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [platform, setPlatform] = useState<WriterPlatform>('youtube')

  if (!doc) return <div className="page" />

  const drafts = [...doc.drafts].sort((a, b) => b.updatedAt - a.updatedAt)
  const draft = drafts.find((d) => d.id === selectedId) ?? drafts[0] ?? null
  const idea = draft?.ideaId ? brand.ideas.find((i) => i.id === draft.ideaId) : undefined

  const add = (from: Idea | null): void => {
    const d = newDraft(from)
    update((doc) => ({ drafts: [d, ...doc.drafts] }))
    setSelectedId(d.id)
  }

  const editDraft = (fn: (d: Draft) => Draft): void => {
    if (!draft) return
    update((doc) => ({
      drafts: doc.drafts.map((d) => (d.id === draft.id ? { ...fn(d), updatedAt: Date.now() } : d))
    }))
  }

  const remove = (): void => {
    if (!draft) return
    if (!window.confirm(`Delete "${draft.title}" and all its versions?`)) return
    update((doc) => ({ drafts: doc.drafts.filter((d) => d.id !== draft.id) }))
    setSelectedId(null)
  }

  return (
    <div className="page">
      <PageHeader title="Writer" chatOpen={chatOpen} onToggleChat={onToggleChat} />
      <div className="scroll wr-scroll">
        <div className="wr-deck">
          <NewDraftMenu ideas={brand.ideas} onPick={add} />
          {drafts.map((d, i) => (
            <DraftCard
              key={d.id}
              draft={d}
              index={i}
              active={d.id === draft?.id}
              onPick={() => setSelectedId(d.id)}
            />
          ))}
        </div>

        {!draft ? (
          <p className="feed-empty">
            No drafts yet. Start one from a saved idea or a blank page, then write it once per site.
          </p>
        ) : (
          <section className="wr-draft" key={draft.id}>
            <div className="wr-draft-head">
              <input
                className="wr-name"
                value={draft.title}
                maxLength={300}
                aria-label="Draft name"
                onChange={(e) => editDraft((d) => ({ ...d, title: e.target.value }))}
              />
              {idea && idea.title !== draft.title && (
                <span className="muted small wr-from" title={idea.title}>
                  from idea: {idea.title}
                </span>
              )}
              <span className="spacer" />
              <button className="icon-btn" title="Delete draft" aria-label="Delete draft" onClick={remove}>
                <TrashIcon />
              </button>
            </div>

            <div className="wr-tabs" role="tablist">
              {PLATFORMS.map((p) => {
                const state = platformFit(p, draft.platforms[p.id])
                return (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={platform === p.id}
                    className={`wr-tab${platform === p.id ? ' on' : ''}`}
                    onClick={() => setPlatform(p.id)}
                  >
                    {p.name}
                    <span className={`wr-dot ${state}`} />
                  </button>
                )
              })}
            </div>

            <Editor
              key={platform}
              brand={brand}
              draft={draft}
              idea={idea}
              spec={SPEC[platform]}
              onOpenChat={() => !chatOpen && onToggleChat()}
              onChange={(fn) =>
                editDraft((d) => ({
                  ...d,
                  platforms: { ...d.platforms, [platform]: fn(d.platforms[platform]) }
                }))
              }
            />
          </section>
        )}
      </div>
    </div>
  )
}
