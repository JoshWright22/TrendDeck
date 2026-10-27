import { useEffect, useState, type ReactNode } from 'react'
import { formatSize, type MediaInfo, type MediaKind } from '@shared/media'
import Modal from '../../components/Modal'
import { Thumb } from './MediaBits'
import './media.css'

interface Props {
  brandId: string
  // gets metadata only, the composer passes ids on and posting resolves them itself
  onPick: (items: MediaInfo[]) => void
  onClose?: () => void
  multiple?: boolean
  kind?: MediaKind
  // the chat composer sets this so only files agents may use show up
  agentOnly?: boolean
}

// drop-in for the chat and post composers
export default function MediaPicker({ brandId, onPick, onClose, multiple = true, kind, agentOnly }: Props): ReactNode {
  const [items, setItems] = useState<MediaInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.trenddeck.media.list(brandId, { query, kind, agentOnly }).then((l) => live && setItems(l))
    }
    load()
    const off = window.trenddeck.media.onChange((id) => id === brandId && load())
    return () => {
      live = false
      off()
    }
  }, [brandId, query, kind, agentOnly])

  const close = onClose ?? ((): void => onPick([]))
  const done = (ids: string[]): void => onPick((items ?? []).filter((m) => ids.includes(m.id)))

  return (
    <Modal title="Attach from Media" onClose={close}>
      <div className="media-picker">
        <input
          className="media-search wide"
          type="search"
          autoFocus
          value={query}
          placeholder="Search names and tags"
          onChange={(e) => setQuery(e.target.value)}
        />
        {items && items.length === 0 ? (
          <p className="muted media-picker-empty">
            {query ? 'Nothing matches.' : 'No files yet. Add some on the Media page.'}
          </p>
        ) : (
          <ul className="media-grid small">
            {(items ?? []).map((m) => (
              <li
                key={m.id}
                className={`media-card${picked.includes(m.id) ? ' sel' : ''}`}
                tabIndex={0}
                onClick={() =>
                  multiple
                    ? setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))
                    : setPicked([m.id])
                }
                onDoubleClick={() => done([m.id])}
              >
                <Thumb item={m} />
                <div className="media-card-name" title={m.name}>
                  {m.name}
                </div>
                <div className="muted small media-card-meta">
                  {m.ext.toUpperCase()}, {formatSize(m.size)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal-actions">
        <span className="muted small">{picked.length ? `${picked.length} picked` : ''}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" disabled={!picked.length} onClick={() => done(picked)}>
          Attach
        </button>
      </div>
    </Modal>
  )
}
