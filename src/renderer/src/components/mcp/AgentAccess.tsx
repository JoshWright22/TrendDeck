import { useEffect, useState, type ReactNode } from 'react'
import type { AccessLogEntry, McpBrandSites, McpState } from '@shared/mcp'
import GatewayRules from './GatewayRules'
import GatewayActivity from './GatewayActivity'
import './agent-access.css'

type Tab = 'rules' | 'activity' | 'sites'
const TABS: { id: Tab; label: string }[] = [
  { id: 'rules', label: 'Rules' },
  { id: 'activity', label: 'Activity' },
  { id: 'sites', label: 'Sites' }
]

type Loaded = McpState & { brands: McpBrandSites[] }

const WORDS: Record<AccessLogEntry['kind'], string> = {
  grant: 'allowed',
  revoke: 'took back',
  'share-once': 'shared for one message',
  read: 'read',
  click: 'clicked on',
  type: 'typed on',
  scroll: 'scrolled',
  upload: 'uploaded to',
  open: 'opened',
  denied: 'was blocked on',
  idea: 'saved an idea',
  draft: 'saved a draft',
  'post-request': 'asked to post on',
  login: 'signed in on'
}

function when(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// settings section: which sites agents may use per brand, what they asked to post, what they did
export default function AgentAccess({ brandId }: { brandId: string | null }): ReactNode {
  const api = window.trenddeckMcp
  const [state, setState] = useState<Loaded | null>(null)
  const [picked, setPicked] = useState<string | null>(brandId)
  const [copied, setCopied] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('rules')

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.getState().then((s) => alive && setState(s))
    }
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api])

  if (!state) return null
  const brand = state.brands.find((b) => b.id === picked) ?? state.brands[0]
  if (!brand) return null
  const granted = new Set(state.grants[brand.id] ?? [])
  const siteName = (id: string): string => brand.sites.find((s) => s.id === id)?.name ?? ''
  const waiting = state.posts.filter((p) => p.brandId === brand.id && p.status === 'waiting')
  const log = state.log.filter((l) => l.brandId === brand.id).slice(-30).reverse()

  return (
    <div className="agent-access">
      <p className="form-hint">
        Agents work through TrendDeck's tools and never see keys, cookies or passwords. Pick what runs on its own and
        what asks you first. Agents only run when you send a chat message.
      </p>

      {state.brands.length > 1 && (
        <div className="aa-brands" role="tablist">
          {state.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === brand.id}
              className={`filter-chip${b.id === brand.id ? ' on' : ''}`}
              onClick={() => setPicked(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div className="gw-tabs" role="tablist" aria-label="Agent access">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rules' && <GatewayRules key={brand.id} brandId={brand.id} />}
      {tab === 'activity' && <GatewayActivity key={brand.id} brandId={brand.id} />}

      {tab === 'sites' && (
      <>
      <p className="form-hint">Agents can't touch a site tab until you allow it here.</p>
      <div className="aa-sites">
        {brand.sites.map((s) => {
          const on = granted.has(s.id)
          return (
            <label key={s.id} className="aa-site">
              <span className="aa-site-name">{s.name}</span>
              <input
                type="checkbox"
                className="aa-switch"
                checked={on}
                onChange={() => void api.setGrant(brand.id, s.id, !on)}
              />
            </label>
          )
        })}
        {brand.sites.length === 0 && <p className="muted small">No sites yet.</p>}
      </div>

      {waiting.length > 0 && (
        <>
          <h4>Waiting for you</h4>
          {waiting.map((p) => (
            <div key={p.id} className="aa-post">
              <div className="aa-post-head">
                <strong>{p.title || p.platform}</strong>
                <span className="muted small">
                  {[p.platform, siteName(p.siteId), p.when ? new Date(p.when).toLocaleString() : '']
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </div>
              <p className="aa-post-body">{p.body}</p>
              <div className="aa-post-actions">
                <button
                  type="button"
                  className="pill"
                  onClick={() => {
                    void navigator.clipboard.writeText(p.title ? `${p.title}\n\n${p.body}` : p.body)
                    setCopied(p.id)
                  }}
                >
                  {copied === p.id ? 'Copied' : 'Copy'}
                </button>
                <button type="button" className="pill teal" onClick={() => void api.setPostStatus(p.id, 'done')}>
                  Posted it
                </button>
                <button type="button" className="btn ghost" onClick={() => void api.setPostStatus(p.id, 'dismissed')}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="aa-log-head">
        <h4>Site activity</h4>
        <span className="spacer" />
        {log.length > 0 && (
          <button type="button" className="btn ghost" onClick={() => void api.clearLog(brand.id)}>
            Clear
          </button>
        )}
      </div>
      {log.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ul className="aa-log">
          {log.map((l) => (
            <li key={l.id}>
              <span className="muted">{when(l.at)}</span> {l.kind === 'grant' || l.kind === 'revoke' ? 'You' : 'Agent'}{' '}
              {WORDS[l.kind]} {siteName(l.siteId)}
              {l.detail && <span className="muted"> {l.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      </>
      )}
    </div>
  )
}
