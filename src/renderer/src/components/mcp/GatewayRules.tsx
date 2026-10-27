import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  APPROVAL_TIMEOUT_MAX,
  APPROVAL_TIMEOUT_MIN,
  RISK_NAMES,
  RISKS,
  type GatewayPolicy,
  type Risk,
  type RiskRule,
  type ToolInfo,
  type ToolRule
} from '@shared/gateway'
import { Dropdown } from '../../chat/ui'

// what agents may do on their own per brand: a rule per risk level, overrides per tool, and
// how long an approval waits before it counts as a no

const RISK_HINTS: Record<Risk, string> = {
  read: 'Looks at brand data',
  edit: 'Changes brand data inside TrendDeck',
  publish: 'Posts to a site or types on the phone',
  spend: 'Costs money or quota'
}

const RULE_LABELS: Record<ToolRule | 'default', string> = {
  default: 'Default',
  auto: 'Auto',
  ask: 'Ask',
  deny: 'Off'
}

export default function GatewayRules({ brandId }: { brandId: string }): ReactNode {
  const api = window.trenddeckGateway
  const [policy, setPolicy] = useState<GatewayPolicy | null>(null)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [timeout, setTimeoutText] = useState('')
  const [filter, setFilter] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setPolicy(null)
    void Promise.all([api.getPolicy(brandId), api.tools()]).then(([p, t]) => {
      if (!alive) return
      setPolicy(p)
      setTimeoutText(String(p.approvalTimeoutSec))
      setTools(t)
    })
    return () => {
      alive = false
    }
  }, [api, brandId])

  const save = async (patch: Partial<Omit<GatewayPolicy, 'brandId'>>): Promise<void> => {
    setError('')
    try {
      const p = await api.setPolicy(brandId, patch)
      setPolicy(p)
      setTimeoutText(String(p.approvalTimeoutSec))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const shown = q ? tools.filter((t) => t.name.includes(q) || t.title.toLowerCase().includes(q)) : tools
    return RISKS.map((r) => [r, shown.filter((t) => t.risk === r)] as const).filter(([, list]) => list.length > 0)
  }, [tools, filter])

  if (!policy) return <p className="muted small">Loading...</p>

  const setRisk = (r: Risk, rule: RiskRule): void => void save({ risks: { ...policy.risks, [r]: rule } })
  const setTool = (name: string, rule: ToolRule | 'default'): void => {
    // main merges tool rules, a null sends one back to its risk rule
    void save({ tools: { [name]: rule === 'default' ? null : rule } as unknown as Record<string, ToolRule> })
  }

  return (
    <div className="gw-rules">
      <div className="gw-risks">
        {RISKS.map((r) => (
          <div key={r} className="gw-risk-row">
            <span className="gw-risk-name">{RISK_NAMES[r]}</span>
            <span className="gw-risk-hint">{RISK_HINTS[r]}</span>
            <span className="spacer" />
            <div className="gw-seg" role="radiogroup" aria-label={`${RISK_NAMES[r]} tools`}>
              {(['auto', 'ask'] as const).map((rule) => (
                <button
                  key={rule}
                  type="button"
                  role="radio"
                  aria-checked={policy.risks[r] === rule}
                  className={policy.risks[r] === rule ? 'on' : ''}
                  onClick={() => setRisk(r, rule)}
                >
                  {rule === 'auto' ? 'Run' : 'Ask'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <label className="gw-timeout">
        <span>Approvals wait</span>
        <input
          type="number"
          min={APPROVAL_TIMEOUT_MIN}
          max={APPROVAL_TIMEOUT_MAX}
          value={timeout}
          aria-label="Approval timeout in seconds"
          onChange={(e) => setTimeoutText(e.target.value)}
          onBlur={() => {
            const n = Math.round(Number(timeout))
            if (!Number.isFinite(n) || n === policy.approvalTimeoutSec) return setTimeoutText(String(policy.approvalTimeoutSec))
            void save({ approvalTimeoutSec: Math.min(APPROVAL_TIMEOUT_MAX, Math.max(APPROVAL_TIMEOUT_MIN, n)) })
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="muted">seconds, then it counts as denied</span>
        <span className="spacer" />
        {saved && <span className="gw-saved">Saved</span>}
      </label>
      {error && <p className="cx-error">{error}</p>}

      <div className="gw-tools-head">
        <h4>Per tool</h4>
        <span className="spacer" />
        <input
          className="gw-filter"
          placeholder="Filter tools"
          aria-label="Filter tools"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {grouped.map(([risk, list]) => (
        <div key={risk} className="gw-group">
          <div className="gw-group-head">
            {RISK_NAMES[risk]}
            <span className="muted">
              {list.length} {list.length === 1 ? 'tool' : 'tools'}, default {policy.risks[risk] === 'auto' ? 'run' : 'ask'}
            </span>
          </div>
          <ul className="gw-tools">
            {list.map((t) => {
              const rule = policy.tools[t.name]
              return (
                <li key={t.name} className={rule === 'deny' ? 'off' : ''}>
                  <span className="gw-tool-title" title={t.description}>
                    {t.title}
                  </span>
                  <code className="gw-tool-name">{t.name}</code>
                  {t.alwaysAsk && <span className="cx-risk">Always asks</span>}
                  <span className="spacer" />
                  <Dropdown
                    className="gw-rule"
                    label={`${t.title} rule`}
                    value={rule ?? 'default'}
                    options={(['default', 'auto', 'ask', 'deny'] as const).map((v) => ({ value: v, label: RULE_LABELS[v] }))}
                    onChange={(v) => setTool(t.name, v)}
                  />
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
