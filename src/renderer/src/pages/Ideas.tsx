import { useState, type ReactNode } from 'react'
import { SOURCE_NAMES } from '@shared/types'
import PageHeader from '../components/PageHeader'
import { age } from '../components/TrendBits'
import { CloseIcon, ExternalIcon, PlusIcon } from '../components/Icons'
import type { PageProps } from './types'

const newId = (): string => crypto.randomUUID()

// a plain list for now, the board comes later
export default function Ideas({ brand, editBrand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const title = draft.trim()
    if (!title) return
    editBrand((b) => ({
      ...b,
      ideas: [{ id: newId(), title, url: '', source: 'manual', savedAt: Date.now() }, ...b.ideas]
    }))
    setDraft('')
  }

  return (
    <div className="page">
      <PageHeader title="Ideas" chatOpen={chatOpen} onToggleChat={onToggleChat} />
      <div className="scroll">
        <form
          className="idea-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            value={draft}
            maxLength={300}
            placeholder="Write an idea down, or save one from Trends"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="pill teal" disabled={!draft.trim()}>
            <PlusIcon />
            Add
          </button>
        </form>

        {brand.ideas.length === 0 ? (
          <p className="feed-empty">No ideas yet. Save a trend and it lands here.</p>
        ) : (
          <ul className="idea-list">
            {brand.ideas.map((idea) => (
              <li key={idea.id} className="idea">
                <div className="idea-main">
                  <span className="idea-title">{idea.title}</span>
                  <span className="muted small">
                    {idea.source === 'manual' ? 'Your idea' : SOURCE_NAMES[idea.source]}, saved{' '}
                    {age(idea.savedAt)} ago
                  </span>
                </div>
                {idea.url && (
                  <a
                    className="icon-btn small"
                    href={idea.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open"
                  >
                    <ExternalIcon />
                  </a>
                )}
                <button
                  className="icon-btn small"
                  title="Remove"
                  aria-label={`Remove ${idea.title}`}
                  onClick={() =>
                    editBrand((b) => ({ ...b, ideas: b.ideas.filter((i) => i.id !== idea.id) }))
                  }
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
