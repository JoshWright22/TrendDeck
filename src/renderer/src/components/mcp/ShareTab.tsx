import { useEffect, useState, type ReactNode } from 'react'
import './agent-access.css'

const ShareIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M12 3v12" />
    <path d="M7 8l5-5 5 5" />
  </svg>
)

// lets the agent use this tab for the next chat message only, the grant in settings is the lasting one
export default function ShareTab({ brandId, siteId, siteName }: { brandId: string; siteId: string; siteName: string }): ReactNode {
  const api = window.trenddeckMcp
  const [on, setOn] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.sharedTab().then((s) => alive && setOn(s?.brandId === brandId && s.siteId === siteId))
    }
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api, brandId, siteId])

  const title = on
    ? `${siteName} goes to the agent with your next message. Click to stop`
    : `Share this tab with the agent for your next message`
  return (
    <button
      className={`icon-btn share-tab${on ? ' on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => void api.shareTabOnce(on ? '' : brandId, on ? '' : siteId)}
    >
      <ShareIcon />
    </button>
  )
}
