import type { ReactNode } from 'react'
import { ShieldIcon } from './Icons'

interface Props {
  on: boolean
  count: number
  // the brand switch is off, so this one can't do anything
  locked?: boolean
  label: string
  onToggle: () => void
}

function short(n: number): string {
  return n > 999 ? `${Math.floor(n / 1000)}k` : String(n)
}

export default function Shield({ on, count, locked, label, onToggle }: Props): ReactNode {
  const active = on && !locked
  const title = locked
    ? `Ad blocker is off for this brand`
    : `Ad blocker ${on ? 'on' : 'off'} for ${label}${active ? `, ${count} blocked` : ''}. Click to turn ${on ? 'off' : 'on'}`
  return (
    <button
      className={`icon-btn shield${active ? ' on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={locked}
      onClick={onToggle}
    >
      <ShieldIcon off={!active} />
      {active && count > 0 && <span className="shield-count">{short(count)}</span>}
    </button>
  )
}
