import { useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import Modal from './Modal'
import AgentAccess from './mcp/AgentAccess'
import SavedLogins from './vault/SavedLogins'

interface Props {
  brandId?: string | null
  settings: Settings
  onSave: (settings: Settings) => void
  onClose: () => void
}

export default function SettingsModal({ brandId, settings, onSave, onClose }: Props): ReactNode {
  const [key, setKey] = useState(settings.youtubeApiKey)
  const [autoUpdate, setAutoUpdate] = useState(settings.autoUpdate !== false)
  return (
    <Modal title="Settings" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ ...settings, youtubeApiKey: key.trim(), autoUpdate })
        }}
      >
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
        <label className="aa-site">
          <span className="aa-site-name">Update automatically</span>
          <input
            type="checkbox"
            className="aa-switch"
            checked={autoUpdate}
            onChange={() => setAutoUpdate(!autoUpdate)}
          />
        </label>
        <p className="form-hint">
          Asks GitHub for the latest version every few hours and installs it when you quit. Nothing
          about you is sent.
        </p>
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
      <AgentAccess brandId={brandId ?? null} />
      <SavedLogins brandId={brandId ?? null} />
    </Modal>
  )
}
