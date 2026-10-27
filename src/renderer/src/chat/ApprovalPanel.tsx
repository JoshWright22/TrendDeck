import { useEffect, useState, type ReactNode } from 'react'
import { RISK_NAMES, type DiffLine } from '@shared/gateway'
import type { PendingItem } from './pending'

// the approval card that sits in the composer while an agent waits for a yes or no.
// t3code style: one quiet panel, the composer's text box doubles as the deny note

export type ApprovalChoice = 'approve' | 'turn' | 'deny'

type Approval = Extract<PendingItem, { kind: 'provider-approval' | 'gateway-approval' }>

const KIND_NAMES: Record<string, string> = {
  command: 'Command',
  'file-change': 'Files',
  tool: 'Tool',
  web: 'Web',
  other: 'Other'
}

const DIFF_MARK: Record<DiffLine['kind'], string> = {
  added: '+',
  removed: '−',
  moved: '↕',
  changed: '~',
  same: ' '
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

function left(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

function argsText(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2)
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text
}

export function Diff({ lines }: { lines: DiffLine[] }): ReactNode {
  return (
    <ul className="cx-diff" aria-label="Pipeline changes">
      {lines.map((l, i) => (
        <li key={`${l.stageId}-${i}`} className={l.kind}>
          <span className="cx-diff-mark" aria-label={l.kind}>
            {DIFF_MARK[l.kind]}
          </span>
          <span className="cx-diff-label">{l.label}</span>
          {l.detail && <span className="cx-diff-detail">{l.detail}</span>}
        </li>
      ))}
    </ul>
  )
}

interface Props {
  item: Approval
  // how many approvals wait in this chat, this is the first
  count: number
  // the composer has text, so deny sends it as the note
  hasNote: boolean
  onRespond: (choice: ApprovalChoice) => void
}

export default function ApprovalPanel({ item, count, hasNote, onRespond }: Props): ReactNode {
  const gw = item.kind === 'gateway-approval' ? item.request : null
  const pv = item.kind === 'provider-approval' ? item.request : null
  const now = useNow(!!gw)
  const remaining = gw ? gw.expiresAt - now : 0
  const badge = gw ? RISK_NAMES[gw.risk] : KIND_NAMES[pv?.kind ?? 'other']
  // the agent's own approvals can only be remembered for the session when it says so
  const canTurn = gw ? true : !!pv?.canRemember
  const [showArgs, setShowArgs] = useState(false)
  const args = gw && Object.keys(gw.args).length ? argsText(gw.args) : ''

  return (
    <div className="cx-approval" role="group" aria-label="Approval needed">
      <div className="cx-approval-head">
        <span className="dot waiting" aria-hidden="true" />
        <span className="cx-approval-kicker">Approval needed</span>
        <span className={`cx-risk ${gw?.risk ?? 'agent'}`}>{badge}</span>
        {gw?.alwaysAsk && <span className="cx-risk">Always asks</span>}
        <span className="spacer" />
        {count > 1 && <span className="muted">1 of {count}</span>}
        {gw && (
          <span className={`cx-approval-time${remaining < 30_000 ? ' soon' : ''}`} title="Counts as denied when it runs out">
            {left(remaining)}
          </span>
        )}
      </div>
      <p className="cx-approval-title">{gw?.title ?? pv?.title}</p>
      {(gw?.summary || pv?.reason) && <p className="cx-approval-summary">{gw?.summary || pv?.reason}</p>}
      {gw?.diff?.length ? <Diff lines={gw.diff} /> : null}
      {pv?.detail && <pre className="cx-approval-args">{pv.detail}</pre>}
      {args &&
        (showArgs || !gw?.diff?.length ? (
          <pre className="cx-approval-args">{args}</pre>
        ) : (
          <button type="button" className="cx-tool" onClick={() => setShowArgs(true)}>
            Show details
          </button>
        ))}
      <div className="cx-approval-actions">
        <span className="cx-approval-hint">
          {hasNote ? 'Enter denies with your note' : 'Type a note to deny with feedback'}
        </span>
        <span className="spacer" />
        <button type="button" className="cx-ap-btn" title="Deny (Esc)" onClick={() => onRespond('deny')}>
          {hasNote ? 'Deny with note' : 'Deny'}
        </button>
        {canTurn && (
          <button
            type="button"
            className="cx-ap-btn"
            title={gw ? 'Approve, and skip asking for this tool until the reply ends (Ctrl+Shift+Enter)' : 'Allow for the rest of this session (Ctrl+Shift+Enter)'}
            onClick={() => onRespond('turn')}
          >
            {gw ? 'Approve for this turn' : 'Always allow'}
          </button>
        )}
        <button type="button" className="cx-ap-btn primary" title="Approve (Ctrl+Enter)" onClick={() => onRespond('approve')}>
          Approve
        </button>
      </div>
    </div>
  )
}
