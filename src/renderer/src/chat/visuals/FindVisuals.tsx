import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  KIND_NAMES,
  LICENSE_FILTERS,
  LICENSE_NAMES,
  ORIENTATION_NAMES,
  ORIENTATIONS,
  VISUAL_KINDS,
  type LicenseFilter,
  type Orientation,
  type VisualKind,
  type VisualSearch
} from '@shared/visuals'
import { Dropdown } from '../ui'
import { cleanError, type CardActions } from '../cards/useCards'
import { VisualGrid } from './VisualItems'
import './visuals.css'

// the composer's search for visuals online: the same sources and grid as the agent's find_visuals.
// nothing goes to the agent until you pick an option and send it
export default function FindVisuals({ a, onClose }: { a: CardActions; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<VisualKind>('image')
  const [orientation, setOrientation] = useState<Orientation | ''>('')
  const [license, setLicense] = useState<LicenseFilter>('commercial')
  const [search, setSearch] = useState<VisualSearch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const run = async (): Promise<void> => {
    if (!query.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      setSearch(
        await window.trenddeckVisuals.search(a.brand.id, a.threadId ?? null, {
          query: query.trim(),
          kind,
          license,
          count: 12,
          ...(orientation ? { orientation } : {})
        })
      )
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vs-find cx-card2" role="dialog" aria-label="Find visuals online">
      <form
        className="vs-find-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <input
          ref={input}
          value={query}
          maxLength={120}
          placeholder="What are you looking for? e.g. city at night"
          aria-label="Search for"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose()
            }
          }}
        />
        <button type="submit" className="primary" disabled={!query.trim() || busy}>
          {busy ? 'Searching...' : 'Search'}
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </form>
      <div className="vs-find-filters">
        <Dropdown label="Kind" value={kind} options={VISUAL_KINDS.map((k) => ({ value: k, label: KIND_NAMES[k] }))} onChange={setKind} />
        <Dropdown
          label="Orientation"
          value={orientation}
          options={[{ value: '' as const, label: 'Any shape' }, ...ORIENTATIONS.map((o) => ({ value: o, label: ORIENTATION_NAMES[o] }))]}
          onChange={setOrientation}
        />
        <Dropdown
          label="License"
          value={license}
          options={LICENSE_FILTERS.map((l) => ({
            value: l,
            label: LICENSE_NAMES[l],
            hint: l === 'any-free' ? 'Some ask for credit or rule out monetized videos' : l === 'commercial' ? 'Fine for monetized videos, some ask for credit' : 'Public domain, CC0, Pexels and Pixabay'
          }))}
          onChange={setLicense}
        />
      </div>
      <p className="cx-card2-note">Openverse and Wikimedia Commons, plus Pexels and Pixabay once you add their free keys in Settings, Media sources.</p>
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
      {busy && !search && <p className="cx-card2-note" role="status">Searching...</p>}
      {search && <VisualGrid key={search.id} search={search} a={a} />}
    </div>
  )
}
