// the agent tool gateway: every tool an agent can call, how risky it is, what the user
// approved, and the audit log. shared by main, preload and the ui

// read: looks at brand data. edit: changes brand data inside TrendDeck.
// publish: something leaves the app or lands on a site. spend: costs money or quota
export const RISKS = ['read', 'edit', 'publish', 'spend'] as const
export type Risk = (typeof RISKS)[number]

export const RISK_NAMES: Record<Risk, string> = {
  read: 'Read',
  edit: 'Edit',
  publish: 'Publish',
  spend: 'Spend'
}

// the mcp tool annotations, sent with tools/list
export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

// what the ui can show about a tool, never how it runs
export interface ToolInfo {
  name: string
  title: string
  description: string
  risk: Risk
  annotations: ToolAnnotations
  // asks every time no matter the policy, e.g. pipeline changes
  alwaysAsk: boolean
}

export type RiskRule = 'auto' | 'ask'
export type ToolRule = 'auto' | 'ask' | 'deny'

export interface GatewayPolicy {
  brandId: string
  // per risk level: run right away or wait for the user
  risks: Record<Risk, RiskRule>
  // per tool name, wins over the risk rule. deny turns a tool off for this brand
  tools: Record<string, ToolRule>
  // seconds an approval waits before it counts as denied
  approvalTimeoutSec: number
}

export const DEFAULT_RISK_RULES: Record<Risk, RiskRule> = {
  read: 'auto',
  edit: 'auto',
  publish: 'ask',
  spend: 'ask'
}

export const APPROVAL_TIMEOUT_DEFAULT = 300
export const APPROVAL_TIMEOUT_MIN = 15
export const APPROVAL_TIMEOUT_MAX = 3600

// what decide() says before a call runs
export type PolicyDecision = 'auto' | 'ask' | 'deny'

// one line of a pipeline change shown as a diff, see @shared/pipeline
export interface DiffLine {
  kind: 'added' | 'removed' | 'moved' | 'changed' | 'same'
  stageId: string
  label: string
  // e.g. "position 2 -> 4" or "auto: off -> on"
  detail: string
}

// main -> renderer on 'gateway:approval-request'
export interface ApprovalRequest {
  id: string
  brandId: string
  threadId: string | null
  turnId: string
  tool: string
  title: string
  risk: Risk
  // already redacted
  args: Record<string, unknown>
  // one plain line, e.g. "Queue a TikTok post: 'Top 5 ...'"
  summary: string
  // pipeline_propose_change fills this in
  diff: DiffLine[] | null
  // true when the policy can't skip it
  alwaysAsk: boolean
  createdAt: number
  expiresAt: number
}

// renderer -> main on 'gateway:approval-respond'
export interface ApprovalResponse {
  id: string
  approve: boolean
  // turn: same tool runs without asking again until this chat message is answered
  scope?: 'once' | 'turn'
  // shown to the agent when denied, e.g. "use a different title"
  note?: string
}

// main -> renderer on 'gateway:approval-closed', the card can go away
export interface ApprovalClosed {
  id: string
  decision: 'approved' | 'denied' | 'timeout' | 'cancelled'
}

export type AuditDecision =
  // ran without asking
  | 'auto'
  // the user said yes
  | 'approved'
  // the user said no
  | 'denied'
  // nobody answered in time
  | 'timeout'
  // the turn ended while waiting
  | 'cancelled'
  // the policy turned the tool off
  | 'blocked'
  // bad args or unknown tool, never ran
  | 'invalid'

export interface AuditEntry {
  id: string
  at: number
  brandId: string
  threadId: string | null
  turnId: string
  tool: string
  risk: Risk | null
  // redacted and cut short
  args: Record<string, unknown>
  decision: AuditDecision
  // the tool ran and didn't fail
  ok: boolean
  // a short redacted summary of what came back, or the error
  result: string
  ms: number
}

export interface AuditQuery {
  limit?: number
  // entries older than this, for paging back
  before?: number
  tool?: string
  threadId?: string
}

// main -> renderer on 'gateway:data-changed' after an agent changed brand data, so a page
// showing it reloads. 'app' means trenddeck.json (ideas, schedule): call loadData() again
export interface DataChanged {
  brandId: string
  kind: 'app' | 'writer' | 'media' | 'posting' | 'inbox' | 'trends' | 'voice'
}

// an inbox reply an agent drafted, one per comment. sentAt is 0 until inbox_send_reply ran
export interface ReplyDraft {
  id: string
  commentId: string
  text: string
  at: number
  sentAt: number
}

export interface GatewayApi {
  tools(): Promise<ToolInfo[]>
  getPolicy(brandId: string): Promise<GatewayPolicy>
  setPolicy(brandId: string, policy: Partial<Omit<GatewayPolicy, 'brandId'>>): Promise<GatewayPolicy>
  pendingApprovals(): Promise<ApprovalRequest[]>
  onApprovalRequest(fn: (req: ApprovalRequest) => void): () => void
  onApprovalClosed(fn: (c: ApprovalClosed) => void): () => void
  respond(res: ApprovalResponse): Promise<boolean>
  audit(brandId: string, query?: AuditQuery): Promise<AuditEntry[]>
  onAudit(fn: (entry: AuditEntry) => void): () => void
  onDataChanged(fn: (c: DataChanged) => void): () => void
  replyDrafts(brandId: string): Promise<ReplyDraft[]>
  removeReplyDraft(brandId: string, id: string): Promise<void>
}

declare global {
  interface Window {
    trenddeckGateway: GatewayApi
  }
}
