import { useState, type ReactNode } from 'react'
import { cleanDomain, hostOf, type Brand, type Settings } from '@shared/types'
import Modal from './Modal'
import { CloseIcon } from './Icons'

type Adblock = Record<string, { on: boolean; allow: string[] }>

interface Props {
  settings: Settings
  brands: Brand[]
  activeId: string | null
  onSave: (settings: Settings, adblock: Adblock) => void
  onClose: () => void
}

function BrandAdblock({
  brand,
  value,
  onChange
}: {
  brand: Brand
  value: Adblock[string]
  onChange: (v: Adblock[string]) => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [bad, setBad] = useState(false)
  // the brand's own sites as one click suggestions
  const suggestions = [...new Set(brand.sites.map((s) => hostOf(s.url)))].filter(
    (h) => h && !value.allow.includes(h)
  )

  const add = (raw: string): void => {
    const domain = cleanDomain(raw)
    if (!domain) {
      setBad(true)
      return
    }
    if (!value.allow.includes(domain)) onChange({ ...value, allow: [...value.allow, domain] })
    setDraft('')
    setBad(false)
  }

  return (
    <div className="adblock-brand">
      <label className="toggle-row">
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        <span>Block ads for {brand.name}</span>
      </label>
      {value.on && (
        <>
          <p className="form-hint">Sites on the allowlist load with their ads. Subdomains count too.</p>
          {value.allow.length > 0 && (
            <div className="chips">
              {value.allow.map((d) => (
                <span key={d} className="chip">
                  {d}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    onClick={() => onChange({ ...value, allow: value.allow.filter((x) => x !== d) })}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="allow-add">
            <input
              value={draft}
              placeholder="example.com"
              spellCheck={false}
              aria-label={`Allow a site for ${brand.name}`}
              onChange={(e) => {
                setDraft(e.target.value)
                setBad(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add(draft)
                }
              }}
            />
            <button type="button" className="btn ghost" disabled={!draft.trim()} onClick={() => add(draft)}>
              Allow
            </button>
          </div>
          {bad && <p className="form-error">That doesn't look like a domain.</p>}
          {suggestions.length > 0 && (
            <div className="suggest">
              {suggestions.map((h) => (
                <button key={h} type="button" className="filter-chip" onClick={() => add(h)}>
                  + {h}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function SettingsModal({ settings, brands, activeId, onSave, onClose }: Props): ReactNode {
  const [key, setKey] = useState(settings.youtubeApiKey)
  const [adblock, setAdblock] = useState<Adblock>(() =>
    Object.fromEntries(brands.map((b) => [b.id, { on: b.adblock, allow: b.adblockAllow }]))
  )
  // the open brand first
  const ordered = [...brands].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))

  return (
    <Modal title="Settings" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ ...settings, youtubeApiKey: key.trim() }, adblock)
        }}
      >
        <h3 className="modal-section">Trends</h3>
        <label>
          YouTube Data API key (optional)
          <input
            value={key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Leave empty to use YouTube search pages"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <p className="form-hint">
          Without a key, Trends reads YouTube's public search pages. A key from Google Cloud gives
          exact view counts. It stays on this computer.
        </p>

        <h3 className="modal-section">Ad blocker</h3>
        <p className="form-hint">
          On for every brand to start, using the same lists as uBlock Origin. They update when the app
          starts and every few hours. Login pages are always left alone.
        </p>
        {ordered.map((b) => (
          <BrandAdblock
            key={b.id}
            brand={b}
            value={adblock[b.id] ?? { on: true, allow: [] }}
            onChange={(v) => setAdblock((all) => ({ ...all, [b.id]: v }))}
          />
        ))}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
