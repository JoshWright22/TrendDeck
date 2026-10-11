import { useEffect, useState, type ReactNode } from 'react'
import type { AgentInfo, AgentUsage, Thread } from '@shared/chat'
import { usePopover } from './ui'
import { chat } from './api'

// rough context size in tokens when the agent didn't say
const estimate = (chars: number): number => Math.round(chars / 4)

function resets(at: number | null): string {
  if (!at) return ''
  const mins = Math.round((at - Date.now()) / 60_000)
  if (mins <= 0) return 'resets soon'
  if (mins < 60) return `resets in ${mins} min`
  if (mins < 48 * 60) return `resets in ${Math.round(mins / 60)} h`
  return `resets ${new Date(at).toLocaleDateString([], { weekday: 'short' })}`
}

function contextOf(thread: Thread | null): { tokens: number; exact: boolean } {
  if (!thread) return { tokens: 0, exact: true }
  const last = [...thread.messages].reverse().find((m) => m.role === 'agent' && m.contextTokens)
  if (last?.contextTokens) return { tokens: last.contextTokens, exact: true }
  return { tokens: estimate(thread.messages.reduce((n, m) => n + m.text.length, 0)), exact: false }
}

// reads saved numbers only, opening this never runs an agent
export default function UsagePopover({ agents, thread }: { agents: AgentInfo[]; thread: Thread | null }): ReactNode {
  const { open, setOpen, root } = usePopover()
  const [usage, setUsage] = useState<AgentUsage[] | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void chat()
      .usage()
      .then((u) => alive && setUsage(u))
    return () => {
      alive = false
    }
  }, [open])

  const ctx = contextOf(thread)
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  return (
    <div className="ui-menu up right cx-usage" ref={root}>
      <button
        type="button"
        className="ui-menu-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Usage and limits"
        title="Usage and limits"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3.46 11.04A5 5 0 1 1 10.54 11.04" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M7 7.5l2.2-2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="ui-pop cx-usage-pop" role="dialog" aria-label="Usage" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <p className="cx-usage-head">This chat</p>
          <p className="cx-usage-ctx">
            {thread ? `${ctx.exact ? '' : 'about '}${ctx.tokens.toLocaleString()} tokens of context` : 'Nothing yet'}
          </p>
          <p className="cx-usage-head">Limits</p>
          {usage === null && <p className="muted small">Reading...</p>}
          {usage?.length === 0 && <p className="muted small">No agents set up</p>}
          {usage?.map((u) => (
            <div key={u.agentId} className="cx-usage-agent">
              <p className="cx-usage-name">{name(u.agentId)}</p>
              {u.windows.length === 0 && <p className="muted small">Unknown. {u.note}</p>}
              {u.windows.map((w) => (
                <div key={w.label} className="cx-usage-row">
                  <span>{w.label}</span>
                  <span className="cx-usage-left">{w.used === null ? 'unknown' : `${Math.max(0, Math.round((1 - w.used) * 100))}% left`}</span>
                  {w.used !== null && (
                    <span className="cx-usage-bar" aria-hidden="true">
                      <span
                        className={w.used > 0.85 ? 'hot' : ''}
                        style={{ width: `${Math.min(100, Math.round(w.used * 100))}%` }}
                      />
                    </span>
                  )}
                  <span className="muted small">{resets(w.resetsAt)}</span>
                </div>
              ))}
              {u.windows.length > 0 && u.seenAt && (
                <p className="muted small">
                  {u.note}, {new Date(u.seenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
