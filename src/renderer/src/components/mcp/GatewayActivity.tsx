import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { RISK_NAMES, type AuditDecision, type AuditEntry, type ToolInfo } from '@shared/gateway'
import type { ThreadSummary } from '@shared/chat'
import { Dropdown } from '../../chat/ui'
import { chat } from '../../chat/api'

// every tool call agents made for a brand, newest first, from the gateway's audit log.
// args are already redacted by main

const PAGE = 60

const DECISION_WORDS: Record<AuditDecision, string> = {
  auto: 'Ran',
  approved: 'Approved',
  denied: 'Denied',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  invalid: 'Invalid'
}

function stamp(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function Row({ e, tool, thread }: { e: AuditEntry; tool: string; thread: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const args = Object.keys(e.args).length ? JSON.stringify(e.args, null, 2) : ''
  const bad = !e.ok || e.decision === 'denied' || e.decision === 'blocked' || e.decision === 'invalid' || e.decision === 'timeout'
  return (
    <li className={`gw-act${open ? ' open' : ''}`}>
      <button type="button" className="gw-act-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`gw-act-dot${bad ? ' bad' : ''}`} aria-hidden="true" />
        <span className="gw-act-time">{stamp(e.at)}</span>
        <span className="gw-act-tool">{tool}</span>
        <span className={`gw-act-decision ${e.decision}`}>{DECISION_WORDS[e.decision]}</span>
        <span className="gw-act-thread">{thread}</span>
        <span className="spacer" />
        {e.risk && <span className="cx-risk">{RISK_NAMES[e.risk]}</span>}
        <span className="gw-act-ms">{e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} s`}</span>
      </button>
      {open && (
        <div className="gw-act-body">
          {args && <pre className="cx-approval-args">{args}</pre>}
          {e.result && <p className="gw-act-result">{e.result}</p>}
        </div>
      )}
    </li>
  )
}

export default function GatewayActivity({ brandId }: { brandId: string }): ReactNode {
  const api = window.trenddeckGateway
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [tool, setTool] = useState('')
  const [threadId, setThreadId] = useState('')
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [threads, setThreads] = useState<ThreadSummary[]>([])

  useEffect(() => {
    void api.tools().then(setTools)
    void chat()
      .listThreads(brandId)
      .then(setThreads)
  }, [api, brandId])

  useEffect(() => {
    let alive = true
    setEntries(null)
    const q = { limit: PAGE, ...(tool ? { tool } : {}), ...(threadId ? { threadId } : {}) }
    void api.audit(brandId, q).then((list) => {
      if (!alive) return
      setEntries(list)
      setMore(list.length >= PAGE)
    })
    const off = api.onAudit((e) => {
      if (e.brandId !== brandId || (tool && e.tool !== tool) || (threadId && e.threadId !== threadId)) return
      setEntries((list) => (list && !list.some((x) => x.id === e.id) ? [e, ...list] : list))
    })
    return () => {
      alive = false
      off()
    }
  }, [api, brandId, tool, threadId])

  const loadMore = (): void => {
    const last = entries?.at(-1)
    if (!last) return
    void api
      .audit(brandId, { limit: PAGE, before: last.at, ...(tool ? { tool } : {}), ...(threadId ? { threadId } : {}) })
      .then((list) => {
        setEntries((cur) => [...(cur ?? []), ...list.filter((e) => !cur?.some((x) => x.id === e.id))])
        setMore(list.length >= PAGE)
      })
  }

  const toolTitle = useMemo(() => new Map(tools.map((t) => [t.name, t.title])), [tools])
  const threadTitle = useMemo(() => new Map(threads.map((t) => [t.id, t.title])), [threads])

  return (
    <div className="gw-activity">
      <div className="gw-act-filters">
        <Dropdown
          className="gw-rule"
          label="Tool"
          value={tool}
          options={[{ value: '', label: 'All tools' }, ...tools.map((t) => ({ value: t.name, label: t.title }))]}
          onChange={setTool}
        />
        <Dropdown
          className="gw-rule"
          label="Chat"
          value={threadId}
          options={[{ value: '', label: 'All chats' }, ...threads.map((t) => ({ value: t.id, label: t.title }))]}
          onChange={setThreadId}
        />
        <span className="spacer" />
        <span className="muted small">Arguments are shown with secrets taken out</span>
      </div>
      {entries === null ? (
        <p className="muted small">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="muted small">No tool calls yet.</p>
      ) : (
        <ul className="gw-acts">
          {entries.map((e) => (
            <Row
              key={e.id}
              e={e}
              tool={toolTitle.get(e.tool) ?? e.tool}
              thread={e.threadId ? (threadTitle.get(e.threadId) ?? 'Chat') : 'No chat'}
            />
          ))}
        </ul>
      )}
      {more && (
        <button type="button" className="tree-add" onClick={loadMore}>
          Older
        </button>
      )}
    </div>
  )
}
