import { useState, type ReactNode } from 'react'
import { STAT_PLATFORMS, type AnalyticsConfig } from '@shared/types'

interface Props {
  config: AnalyticsConfig
  onSave: (config: AnalyticsConfig) => void
  onClear: () => void
  onClose: () => void
}

const NAMES = { youtube: 'YouTube Studio', tiktok: 'TikTok', instagram: 'Instagram' } as const

// which sites refresh reads, and the optional official api keys
export default function Sources({ config, onSave, onClear, onClose }: Props): ReactNode {
  const [c, setC] = useState(config)
  return (
    <form
      className="an-sources"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(c)
      }}
    >
      <h3>Sources</h3>
      <div className="an-toggles">
        {STAT_PLATFORMS.map((p) => (
          <label key={p} className="an-toggle">
            <input
              type="checkbox"
              checked={c.enabled[p]}
              onChange={(e) => setC({ ...c, enabled: { ...c.enabled, [p]: e.target.checked } })}
            />
            {NAMES[p]}
          </label>
        ))}
      </div>
      <p className="muted small">
        Without keys, refresh reads the pages you're logged into in this brand. Keys are optional and used
        first when they're set. They stay on this computer.
      </p>
      <label>
        YouTube channel id or @handle
        <input
          value={c.youtubeChannel}
          spellCheck={false}
          placeholder="UC... or @yourchannel, uses the YouTube key from Settings"
          onChange={(e) => setC({ ...c, youtubeChannel: e.target.value })}
        />
      </label>
      <label>
        Instagram access token
        <input
          value={c.instagramToken}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="From the Instagram API with Instagram Login"
          onChange={(e) => setC({ ...c, instagramToken: e.target.value })}
        />
      </label>
      <label>
        TikTok access token
        <input
          value={c.tiktokToken}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Display API token with user.info.stats and video.list"
          onChange={(e) => setC({ ...c, tiktokToken: e.target.value })}
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn ghost an-clear" onClick={onClear}>
          Delete saved readings
        </button>
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save
        </button>
      </div>
    </form>
  )
}
