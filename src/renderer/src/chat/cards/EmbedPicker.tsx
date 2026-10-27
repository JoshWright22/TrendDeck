import { useState, type ReactNode } from 'react'
import type { Project } from '@shared/workspace'
import { putCraft, useCraftApps, errorText } from '../../workspace/craft/store'
import { pinEmbed } from './embed-owner'

// opens a Craft app as an embed at the end of the chat, the same embed the agent posts. in the
// chat's header so nothing sits between the header and the messages
export default function EmbedPicker({
  brandId,
  threadId,
  project,
  onOpened
}: {
  brandId: string
  threadId: string | null
  project: Project
  onOpened?: () => void
}): ReactNode {
  const apps = useCraftApps()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.trenddeckEmbed
  if (!api || !apps) return null

  const open = async (appId: string): Promise<void> => {
    if (!appId || !threadId || busy) return
    setBusy(true)
    setError('')
    try {
      const cardId = await api.create(brandId, threadId, project.id, appId)
      pinEmbed(cardId)
      putCraft(await api.open(brandId, cardId))
      onOpened?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="cx-embed-picker">
      <select
        aria-label="Open a Craft editor in this chat"
        value=""
        disabled={busy || !threadId}
        title={threadId ? undefined : 'Send a message first, the editor opens in that chat'}
        onChange={(e) => void open(e.currentTarget.value)}
      >
        <option value="">{busy ? 'Opening' : 'Open an editor'}</option>
        {apps.map((s) => (
          <option key={s.app.id} value={s.app.id}>
            {s.app.name}
            {s.install.kind === 'installed' ? '' : ' (installs first)'}
          </option>
        ))}
      </select>
      {error && (
        <span className="cx-embed-picker-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </span>
  )
}
