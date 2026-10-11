import { memo, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { SOURCE_NAMES, type Idea } from '@shared/types'
import { ExternalIcon, TrashIcon } from '../../components/Icons'
import { CardCorners } from './RisingMark'
import { hostOf, stageOf } from './board'

interface Props {
  idea: Idea
  index: number
  popping: boolean
  dragging: boolean
  slots: number
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onShift: (id: string, dir: -1 | 1) => void
  onTag: (tag: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragOverCard: (e: DragEvent<HTMLElement>, id: string) => void
}

function sourceLabel(idea: Idea): string {
  if (idea.source !== 'manual') return SOURCE_NAMES[idea.source]
  return hostOf(idea.url) || 'Your idea'
}

const BURST = [0, 1, 2, 3, 4, 5, 6, 7]

function IdeaCard(props: Props): ReactNode {
  const { idea, index, popping, dragging, slots } = props
  const posted = stageOf(idea) === 'posted'
  const tags = idea.tags ?? []

  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onOpen(idea.id)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      props.onDelete(idea.id)
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      props.onShift(idea.id, e.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  return (
    <article
      className={`ib-card${posted ? ' posted' : ''}${popping ? ' pop' : ''}${dragging ? ' dragging' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      tabIndex={0}
      draggable
      aria-label={idea.title}
      title="Click to edit, drag to move. Alt + arrows moves a column."
      onClick={() => props.onOpen(idea.id)}
      onKeyDown={onKey}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/x-trenddeck-idea', idea.id)
        props.onDragStart(idea.id)
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => props.onDragOverCard(e, idea.id)}
    >
      <CardCorners tone={posted ? 'win' : undefined} />
      <h4 className="ib-title">{idea.title}</h4>
      {idea.notes && <p className="ib-notes">{idea.notes}</p>}
      <span className="spacer" />
      {tags.length > 0 && (
        <div className="ib-tags">
          {tags.map((t) => (
            <button
              key={t}
              className="ib-tag"
              title={`Show #${t}`}
              onClick={(e) => {
                e.stopPropagation()
                props.onTag(t)
              }}
            >
              #{t}
            </button>
          ))}
        </div>
      )}
      <footer className="ib-foot">
        <span className="ib-source" title={idea.url || undefined}>
          {sourceLabel(idea)}
        </span>
        {slots > 0 && (
          <span className="ib-slots" title="Planned posts on the schedule">
            {slots}
          </span>
        )}
        {idea.url && (
          <a
            className="icon-btn small"
            href={idea.url}
            target="_blank"
            rel="noreferrer"
            title="Open the source"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalIcon />
          </a>
        )}
        <button
          className="icon-btn small ib-del"
          title="Delete"
          aria-label={`Delete ${idea.title}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete(idea.id)
          }}
        >
          <TrashIcon />
        </button>
      </footer>
      {popping && (
        <span className="ib-burst" aria-hidden="true">
          {BURST.map((n) => (
            <i key={n} style={{ ['--a' as string]: `${n * 45}deg` }} />
          ))}
        </span>
      )}
    </article>
  )
}

export default memo(IdeaCard)
