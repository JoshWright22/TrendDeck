// which calls run on their own and which wait for the user. pure, no electron
import {
  APPROVAL_TIMEOUT_DEFAULT,
  APPROVAL_TIMEOUT_MAX,
  APPROVAL_TIMEOUT_MIN,
  DEFAULT_RISK_RULES,
  RISKS,
  type GatewayPolicy,
  type PolicyDecision,
  type Risk,
  type RiskRule,
  type ToolRule
} from '../../shared/gateway'

export interface DecideTool {
  name: string
  risk: Risk
  alwaysAsk?: boolean
}

export function defaultPolicy(brandId: string): GatewayPolicy {
  return { brandId, risks: { ...DEFAULT_RISK_RULES }, tools: {}, approvalTimeoutSec: APPROVAL_TIMEOUT_DEFAULT }
}

// never trust the file or the renderer
export function cleanPolicy(brandId: string, raw: unknown): GatewayPolicy {
  const p = (raw ?? {}) as Partial<GatewayPolicy>
  const out = defaultPolicy(brandId)
  const risks = (p.risks ?? {}) as Partial<Record<Risk, unknown>>
  for (const r of RISKS) {
    if (risks[r] === 'auto' || risks[r] === 'ask') out.risks[r] = risks[r] as RiskRule
  }
  for (const [name, rule] of Object.entries((p.tools ?? {}) as Record<string, unknown>)) {
    if (/^[a-z][a-z0-9_]{0,63}$/.test(name) && (rule === 'auto' || rule === 'ask' || rule === 'deny')) {
      out.tools[name] = rule as ToolRule
    }
  }
  const t = Math.round(Number(p.approvalTimeoutSec))
  if (Number.isFinite(t)) out.approvalTimeoutSec = Math.min(APPROVAL_TIMEOUT_MAX, Math.max(APPROVAL_TIMEOUT_MIN, t))
  return out
}

// deny on the tool wins, then tools that always ask, then what the user allowed for this turn,
// then the tool's own rule, then its risk level
export function decide(
  policy: GatewayPolicy,
  tool: DecideTool,
  allowedThisTurn: ReadonlySet<string> = new Set(),
  mustAsk = false
): PolicyDecision {
  const rule = policy.tools[tool.name]
  if (rule === 'deny') return 'deny'
  if (tool.alwaysAsk || mustAsk) return 'ask'
  if (allowedThisTurn.has(tool.name)) return 'auto'
  if (rule === 'auto' || rule === 'ask') return rule
  return policy.risks[tool.risk] ?? 'ask'
}
