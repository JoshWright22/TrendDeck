import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import { STYLE_RULE_CHARS, STYLE_RULE_MAX, type ContextState, type StyleRule } from '@shared/context'
import './context.css'

function size(chars: number): string {
  if (!chars) return 'No text found'
  if (chars < 1000) return `${chars} characters`
  if (chars < 1_000_000) return `${Math.round(chars / 1000)}k characters`
  return `${(chars / 1_000_000).toFixed(1)}M characters`
}

function when(at: number): string {
  const d = new Date(at)
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const FROM: Record<StyleRule['source'], string> = {
  agent: 'Suggested by your agent',
  user: 'Added by you'
}

function RuleRow({ brandId, rule }: { brandId: string; rule: StyleRule }): ReactNode {
  const api = window.trenddeckContext
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    if (draft === null) return
    if (draft.trim() === rule.text) {
      setDraft(null)
      setError('')
      return
    }
    const why = await api.editRule(brandId, rule.id, draft)
    if (why) setError(why)
    else {
      setDraft(null)
      setError('')
    }
  }

  return (
    <li>
      {draft === null ? (
        <div className="ctx-rule">
          <div className="ctx-rule-text">{rule.text}</div>
          <div className="ctx-rule-from" title={rule.why}>
            {FROM[rule.source]}
            {rule.why ? `. ${rule.why.replace(/^because\s+/i, '').replace(/^./, (c) => c.toUpperCase())}` : ''}
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      ) : (
        <div className="ctx-rule">
          <div className="allow-add">
            <input
              className="ctx-input"
              value={draft}
              maxLength={STYLE_RULE_CHARS + 20}
              autoFocus
              aria-label="Edit rule"
              onChange={(e) => {
                setDraft(e.target.value)
                setError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void save()
                } else if (e.key === 'Escape') {
                  setDraft(null)
                  setError('')
                }
              }}
            />
            <button type="button" className="btn ghost small" onClick={() => void save()}>
              Save
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => {
                setDraft(null)
                setError('')
              }}
            >
              Cancel
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}
      {draft === null && (
        <>
          <button type="button" className="btn ghost small" onClick={() => setDraft(rule.text)}>
            Edit
          </button>
          <button type="button" className="btn ghost small" onClick={() => void api.removeRule(brandId, rule.id)}>
            Delete
          </button>
        </>
      )}
    </li>
  )
}

// settings section: what the chat agent can read for this brand besides the chat itself
export default function ContextSection({ brand }: { brand: Brand }): ReactNode {
  const api = window.trenddeckContext
  const [state, setState] = useState<ContextState | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setState(null)
    setDraft('')
    setError('')
    const load = (): void => {
      void api.get(brand.id).then((s) => alive && setState(s))
    }
    load()
    const off = api.onChanged((id) => id === brand.id && load())
    return () => {
      alive = false
      off()
    }
  }, [api, brand.id])

  if (!state) return <p className="form-hint">Loading...</p>

  const act = async (fn: () => Promise<ContextState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await fn())
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    if (!draft.trim()) return
    const why = await api.addRule(brand.id, draft)
    if (why) setError(why)
    else {
      setDraft('')
      setError('')
    }
  }

  const rules = [...state.rules].sort((a, b) => b.createdAt - a.createdAt)
  const full = state.rules.length >= STYLE_RULE_MAX
  const withText = state.docs.filter((d) => d.chars > 0).length

  return (
    <div className="context-settings">
      <p className="form-hint">
        What your agent can read about {brand.name} besides the chat. It looks things up here when it needs them.
      </p>

      <h4>Brand docs</h4>
      <p className="form-hint">
        Pick a folder with your brand guide, scripts or notes. Your agent can search the markdown, text and pdf files
        in it, up to 500 files. Subfolders count too.
      </p>
      {state.docsFolder && <div className="ctx-folder">{state.docsFolder}</div>}
      <div className="row-actions">
        <button
          type="button"
          className={state.docsFolder ? 'btn ghost' : 'btn primary'}
          disabled={busy}
          onClick={() => void act(() => api.pickFolder(brand.id))}
        >
          {state.docsFolder ? 'Change folder' : 'Pick folder'}
        </button>
        {state.docsFolder && (
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || state.indexing}
              onClick={() => void act(() => api.reindex(brand.id))}
            >
              Re-index
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => api.clearFolder(brand.id))}>
              Stop using it
            </button>
          </>
        )}
      </div>
      {state.error && <p className="form-error">{state.error}</p>}
      {state.docsFolder && (
        <p className="ctx-status">
          {state.indexing
            ? 'Indexing your docs. Big pdfs can take a minute.'
            : state.docs.length
              ? `${state.docs.length} ${state.docs.length === 1 ? 'file' : 'files'} indexed, ${withText} with text.${state.lastIndexedAt ? ` Last checked ${when(state.lastIndexedAt)}.` : ''}`
              : 'No markdown, text or pdf files in this folder yet.'}
        </p>
      )}
      {state.docs.length > 0 && (
        <ul className="settings-sites ctx-list">
          {state.docs.map((d) => (
            <li key={d.file}>
              <span className="ctx-name" title={d.file}>
                {d.file}
              </span>
              <span className="ctx-size">{size(d.chars)}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>
        Past videos <span className="ctx-count">{state.transcripts.length}</span>
      </h4>
      <p className="form-hint">
        Captions and transcripts in your project folders: .srt and .vtt files, and .txt files with transcript or captions
        in the name. Your agent can search them to match how you talk.
      </p>
      {state.transcripts.length > 0 ? (
        <ul className="settings-sites ctx-list">
          {state.transcripts.map((t) => (
            <li key={`${t.project}/${t.file}`}>
              <span className="ctx-name" title={`${t.project}/${t.file}`}>
                {t.project}/{t.file}
              </span>
              <span className="ctx-size">{size(t.chars)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ctx-status">No transcripts found yet. Drop caption files into a project folder and they show up here.</p>
      )}

      <h4>
        Style rules{' '}
        <span className="ctx-count">
          {state.rules.length} of {STYLE_RULE_MAX}
        </span>
      </h4>
      <p className="form-hint">
        Short rules your agent follows every time, like how you cut or words you never use. Your agent can suggest
        one, and it's only saved when you approve it.
      </p>
      {rules.length > 0 && (
        <ul className="settings-sites ctx-rules">
          {rules.map((r) => (
            <RuleRow key={r.id} brandId={brand.id} rule={r} />
          ))}
        </ul>
      )}
      <div className="allow-add">
        <input
          value={draft}
          maxLength={STYLE_RULE_CHARS + 20}
          placeholder={full ? `You have ${STYLE_RULE_MAX} rules, delete one to add more` : 'Never use the word "insane" in titles'}
          disabled={full}
          aria-label={`Add a style rule for ${brand.name}`}
          onChange={(e) => {
            setDraft(e.target.value)
            setError('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
        />
        <button type="button" className="btn ghost" disabled={full || !draft.trim()} onClick={() => void add()}>
          Add rule
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}
