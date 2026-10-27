import { useEffect, useState, type ReactNode } from 'react'
import type { MediaSourceKeys } from '@shared/visuals'
import './media-sources.css'

// settings section: free keys for Pexels and Pixabay. a saved key is encrypted on this computer
// and never comes back to this view or to an agent, the view only learns that one is saved

const SOURCES = [
  {
    id: 'pexels' as const,
    name: 'Pexels',
    url: 'https://www.pexels.com/api/',
    how: 'Free photos and videos. Sign in at pexels.com/api and copy your API key. Up to 200 searches an hour.'
  },
  {
    id: 'pixabay' as const,
    name: 'Pixabay',
    url: 'https://pixabay.com/api/docs/',
    how: 'Free photos, illustrations and videos. Sign in, then copy the key from the API documentation page. Searches are kept for a day, as Pixabay asks.'
  }
]

export default function MediaSourcesSection(): ReactNode {
  const api = window.trenddeckVisuals
  const [keys, setKeys] = useState<MediaSourceKeys | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void api.keys().then(setKeys).catch(() => setKeys({ pexels: false, pixabay: false, canStore: false }))
  }, [api])

  const act = async (fn: () => Promise<MediaSourceKeys>, done: string): Promise<void> => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      setKeys(await fn())
      setNote(done)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!keys) return <p className="form-hint">Loading...</p>
  return (
    <div className="ms-sources">
      <p className="form-hint">
        Where your agent and the chat's Find visuals look for images, clips, GIFs and audio. Openverse and Wikimedia Commons work
        without a key. Each result keeps its source, author and license, and a file you add to a video gets a .credit.json next to it.
      </p>
      {!keys.canStore && <p className="form-error">Windows can't encrypt keys for TrendDeck right now, so keys can't be saved.</p>}
      {SOURCES.map((s) => (
        <div key={s.id} className="ms-source">
          <h4>{s.name}</h4>
          <p className="form-hint">
            {s.how}{' '}
            <a href={s.url} target="_blank" rel="noreferrer">
              Get a key
            </a>
          </p>
          <label>
            {s.name} API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft[s.id] ?? ''}
              placeholder={keys[s.id] ? 'Saved. Paste a new one to replace it' : 'Paste the key'}
              onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !keys.canStore || !(draft[s.id] ?? '').trim()}
              onClick={() =>
                void act(async () => {
                  const out = await api.setKey(s.id, draft[s.id] ?? '')
                  setDraft((d) => ({ ...d, [s.id]: '' }))
                  return out
                }, `${s.name} key saved. It's encrypted on this computer.`)
              }
            >
              Save key
            </button>
            {keys[s.id] && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => api.clearKey(s.id), `${s.name} key removed.`)}>
                Remove key
              </button>
            )}
          </div>
          <p className="form-hint">{keys[s.id] ? `${s.name} is on.` : `${s.name} is off until you add a key.`}</p>
        </div>
      ))}
      {note && <p className="form-hint">{note}</p>}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}
