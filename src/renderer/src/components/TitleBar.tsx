import { useEffect, useState, type ReactNode } from 'react'
import logo from '../../../../resources/logo.svg'

const isMac = window.trenddeck.platform === 'darwin'

export function WindowButtons(): ReactNode {
  const [max, setMax] = useState(false)
  const [update, setUpdate] = useState<string | null>(null)
  useEffect(() => {
    void window.trenddeck.windowControl('state').then(setMax)
    return window.trenddeck.onMaximized(setMax)
  }, [])
  useEffect(() => {
    void window.trenddeck.updateReady().then(setUpdate)
    return window.trenddeck.onUpdateReady(setUpdate)
  }, [])
  return (
    <div className="win-buttons">
      {update && (
        <button
          className="update-btn"
          title={`Version ${update} is ready. Restarts TrendDeck.`}
          onClick={() => void window.trenddeck.installUpdate()}
        >
          Update
        </button>
      )}
      <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => void window.trenddeck.windowControl('minimize')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        className="win-btn"
        title={max ? 'Restore' : 'Maximize'}
        aria-label={max ? 'Restore' : 'Maximize'}
        onClick={() => void window.trenddeck.windowControl('maximize').then(setMax)}
      >
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" stroke="currentColor" />
            <path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" rx="2" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button className="win-btn close" title="Close" aria-label="Close" onClick={() => void window.trenddeck.windowControl('close')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}

// the whole bar drags the window, double click maximizes. anything clickable opts out in css
export default function TitleBar(): ReactNode {
  return (
    <header className={`titlebar${isMac ? ' mac' : ''}`}>
      <img className="title-logo" src={logo} alt="" draggable={false} />
      <span className="title-name">TrendDeck</span>
      <span className="spacer" />
      {!isMac && <WindowButtons />}
    </header>
  )
}
