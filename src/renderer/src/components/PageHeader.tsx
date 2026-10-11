import type { ReactNode } from 'react'
import { PanelIcon } from './Icons'

interface ToggleProps {
  chatOpen: boolean
  onToggleChat: () => void
}

export function ChatToggle({ chatOpen, onToggleChat }: ToggleProps): ReactNode {
  return (
    <button
      className={`icon-btn${chatOpen ? ' on' : ''}`}
      title={chatOpen ? 'Hide chat' : 'Show chat'}
      aria-label="Toggle chat"
      aria-pressed={chatOpen}
      onClick={onToggleChat}
    >
      <PanelIcon />
    </button>
  )
}

interface Props extends ToggleProps {
  title?: string
  children?: ReactNode
}

export default function PageHeader({ title, children, ...toggle }: Props): ReactNode {
  return (
    <header className="page-head">
      {title && <h2>{title}</h2>}
      {children}
      <span className="spacer" />
      <ChatToggle {...toggle} />
    </header>
  )
}
