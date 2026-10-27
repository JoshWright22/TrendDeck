import type { ReactNode } from 'react'

interface Props {
  title: string
  text: string
  action?: { label: string; onClick: () => void }
}

// a stage with nothing to edit by hand yet
export default function Placeholder({ title, text, action }: Props): ReactNode {
  return (
    <div className="page ws-placeholder">
      <div className="ws-placeholder-body">
        <h2>{title}</h2>
        <p>{text}</p>
        {action && (
          <button className="btn" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
