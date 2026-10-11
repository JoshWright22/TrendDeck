import { useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import Modal from './Modal'
import { CloseIcon } from './Icons'

interface Props {
  // null means we are making a new brand
  brand: Brand | null
  onSave: (name: string, keywords: string[]) => void
  onDelete: () => void
  onClose: () => void
}

export default function BrandModal({ brand, onSave, onDelete, onClose }: Props): ReactNode {
  const [name, setName] = useState(brand?.name ?? '')
  const [keywords, setKeywords] = useState<string[]>(brand?.keywords ?? [])
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const withDraft = (): string[] => {
    const extra = draft
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    const all = [...keywords]
    for (const k of extra) {
      if (!all.some((x) => x.toLowerCase() === k.toLowerCase())) all.push(k)
    }
    return all
  }

  const commitDraft = (): void => {
    setKeywords(withDraft())
    setDraft('')
  }

  const canSave = name.trim().length > 0

  return (
    <Modal title={brand ? 'Edit brand' : 'New brand'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) onSave(name.trim(), withDraft())
        }}
      >
        <label>
          Name
          <input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Brand name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label>
          Niche keywords
          <input
            value={draft}
            placeholder="Type one and press Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                commitDraft()
              }
            }}
            onBlur={commitDraft}
          />
        </label>
        {keywords.length > 0 && (
          <div className="chips">
            {keywords.map((k) => (
              <span key={k} className="chip">
                {k}
                <button
                  type="button"
                  aria-label={`Remove ${k}`}
                  onClick={() => setKeywords(keywords.filter((x) => x !== k))}
                >
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="modal-actions">
          {brand &&
            (confirmDelete ? (
              <button type="button" className="btn danger" onClick={onDelete}>
                Delete and log out of its sites
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                Delete brand
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            {brand ? 'Save' : 'Add brand'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
