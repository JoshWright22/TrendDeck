import type { ReactNode } from 'react'
import { CloseIcon } from './Icons'

export default function ChatPane({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <aside className="chat panel" aria-label="Chat">
      <header>
        <h3>Chat</h3>
        <button className="icon-btn" title="Hide chat" aria-label="Hide chat" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="chat-body">
        <span className="badge">Coming soon</span>
        <p>Ask about your trends, ideas and numbers for the brand you have open.</p>
      </div>
      <input className="chat-input" disabled placeholder="Chat isn't hooked up yet" />
    </aside>
  )
}
