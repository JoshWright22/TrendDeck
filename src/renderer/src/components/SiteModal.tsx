import { useState, type ReactNode } from 'react'
import { isHttpUrl } from '@shared/types'
import Modal from './Modal'

interface Props {
  onSave: (name: string, url: string) => void
  onClose: () => void
}

function normalize(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  return isHttpUrl(url) ? url : null
}

export default function SiteModal({ onSave, onClose }: Props): ReactNode {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const clean = normalize(url)
  const canSave = name.trim().length > 0 && clean !== null

  return (
    <Modal title="Add site" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave && clean) onSave(name.trim(), clean)
        }}
      >
        <label>
          Name
          <input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Twitch"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          URL
          <input value={url} placeholder="twitch.tv" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {url.trim() && !clean && <p className="form-error">That doesn't look like a web address</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            Add site
          </button>
        </div>
      </form>
    </Modal>
  )
}
