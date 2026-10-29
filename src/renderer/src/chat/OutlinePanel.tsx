import { useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from './Markdown'

// the video's outline beside the chat: the points or script the agent keeps in the project at
// scripts/outline.md. it follows the file while it's open, so the agent's changes show as they
// land, and you can edit it yourself

const POLL_MS = 2000

export default function OutlinePanel({ brandId, projectId, projectName, onClose }: { brandId: string; projectId: string; projectName: string; onClose: () => void }): ReactNode {
  const api = window.trenddeckScripts
  const [text, setText] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const seen = useRef(0)

  useEffect(() => {
    let alive = true
    seen.current = 0
    setText(null)
    setDraft(null)
    const load = (): void => {
      void api
        .outline(brandId, projectId)
        .then((o) => {
          if (!alive || o.mtime === seen.current) return
          seen.current = o.mtime
          setText(o.text)
        })
        .catch(() => {})
    }
    load()
    const t = window.setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [api, brandId, projectId])

  const save = async (): Promise<void> => {
    if (draft === null) return
    setError('')
    try {
      const o = await api.saveOutline(brandId, projectId, draft)
      seen.current = o.mtime
      setText(o.text)
      setDraft(null)
    } catch {
      setError("Couldn't save the outline.")
    }
  }

  return (
    <aside className="cx-outline" aria-label="Outline">
      <header className="cx-outline-head">
        <strong>Outline</strong>
        <span className="muted">{projectName}</span>
        <span className="spacer" />
        {draft === null ? (
          <button type="button" className="ws-head-btn" disabled={text === null} onClick={() => setDraft(text ?? '')}>
            Edit
          </button>
        ) : (
          <>
            <button type="button" className="ws-head-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="ws-head-btn primary" onClick={() => void save()}>
              Save
            </button>
          </>
        )}
        <button type="button" className="ws-head-btn" aria-label="Close the outline" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="cx-outline-body">
        {draft !== null ? (
          <textarea className="cx-outline-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck aria-label="Outline text" />
        ) : text === null ? (
          <p className="muted">Loading...</p>
        ) : text.trim() ? (
          <Markdown text={text} />
        ) : (
          <p className="muted">No outline for this video yet. Ask your agent for the talking points and they show up here, kept up to date as you work.</p>
        )}
        {error && (
          <p className="cx-card2-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </aside>
  )
}
