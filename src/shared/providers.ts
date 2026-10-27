// provider layer types shared by the main process, the preload and the chat view.
// the old chat:event stream in chat.ts stays as it was; everything new (approvals,
// steer and queue, plans, permission modes) comes in on chat:provider-event so a
// renderer that only knows the old events keeps working

import type { ThreadMessage } from './chat'

// how much an agent may do without asking, per thread
// supervised: asks before every app tool call and anything else that changes things
// auto-accept-edits: app tools and file edits go through, the rest asks
// auto: the agent's own judgement (claude's classifier, codex on-request), asks when unsure
// full-access: never asks
export type PermissionMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access'

export const PERMISSION_MODES: PermissionMode[] = ['supervised', 'auto-accept-edits', 'auto', 'full-access']
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto-accept-edits'

export const isPermissionMode = (v: unknown): v is PermissionMode =>
  typeof v === 'string' && (PERMISSION_MODES as string[]).includes(v)

// which adapter runs an agent
export type ProviderKind = 'claude-sdk' | 'codex-app-server' | 'legacy-cli' | 'legacy-command' | 'legacy-api' | 'pi-ai'

export interface ProviderCapabilities {
  // input can go into a turn that's still running
  steer: boolean
  // asks before tools mid turn, answered with chat:approval
  approvals: boolean
  // can ask the user structured questions mid turn, answered with chat:user-input
  userInput: boolean
  // keeps its own session between turns
  resume: boolean
  // can stop a turn without killing the process
  interrupt: boolean
  // models come from the agent itself, not a fixed list
  liveModels: boolean
  // honors the thread's permission mode
  permissionModes: boolean
}

export type ApprovalKind = 'command' | 'file-change' | 'tool' | 'web' | 'other'

export interface ApprovalRequest {
  // unique per request, what chat:approval answers
  requestId: string
  kind: ApprovalKind
  // short line, e.g. "Run a command" or "Use TrendDeck: request_post"
  title: string
  // the command, the file paths, the tool input. plain text, show as is
  detail: string
  // raw tool name from the agent
  tool?: string
  // the agent's reason, when it gives one
  reason?: string
  // the agent can remember an allow for the rest of the session
  canRemember: boolean
  at: number
}

export type ApprovalDecision = 'allow' | 'deny'

export interface ApprovalRecord extends ApprovalRequest {
  // pending until answered. expired when the turn ended first
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  feedback?: string
}

export interface UserInputQuestion {
  id: string
  question: string
  header?: string
  multi: boolean
  options: { label: string; description?: string }[]
}

export interface UserInputRequest {
  requestId: string
  questions: UserInputQuestion[]
  at: number
}

export interface PlanStep {
  text: string
  status: 'pending' | 'in-progress' | 'done'
}

// a message waiting for the running turn to end. lives in the main process per thread
export interface QueuedMessage {
  id: string
  text: string
  agentId: string
  at: number
}

// result of chat:steer. agents that can't take input mid turn get it queued instead
export interface SteerResult {
  mode: 'steered' | 'queued' | 'sent'
  threadId: string
  // steered: the user message saved before the running reply
  messageId?: string
  // sent: the new reply, like SendResult.messageId
  replyId?: string
  // queued: the queue entry
  queueId?: string
}

export type ProviderChatEvent =
  | { type: 'approval'; brandId: string; threadId: string; messageId: string; request: ApprovalRequest }
  | {
      type: 'approval-resolved'
      brandId: string
      threadId: string
      messageId: string
      requestId: string
      status: ApprovalRecord['status']
    }
  | { type: 'user-input'; brandId: string; threadId: string; messageId: string; request: UserInputRequest }
  | { type: 'user-input-resolved'; brandId: string; threadId: string; messageId: string; requestId: string }
  | { type: 'plan'; brandId: string; threadId: string; messageId: string; plan: PlanStep[] }
  // a steered message went into the running turn. it's saved right before the reply it went into
  | { type: 'steer'; brandId: string; threadId: string; messageId: string; message: ThreadMessage }
  | { type: 'queue'; brandId: string; threadId: string; queue: QueuedMessage[] }
  | { type: 'permission-mode'; brandId: string; threadId: string; mode: PermissionMode }
  // the agent changed mid thread and got a summary of the turns it didn't see
  | { type: 'handoff'; brandId: string; threadId: string; messageId: string; fromAgentIds: string[]; toAgentId: string }
  | {
      type: 'usage'
      brandId: string
      threadId: string
      messageId: string
      contextTokens?: number
      inputTokens?: number
      outputTokens?: number
    }

export interface ProviderInfo {
  agentId: string
  kind: ProviderKind
  capabilities: ProviderCapabilities
}

// the extra half of window.trenddeckChat, next to ChatApi
export interface ProviderChatApi {
  // adapter and capabilities per agent, so the composer knows if it can steer
  providers(): Promise<ProviderInfo[]>
  // answers an approval request. feedback goes back to the agent with a deny
  respondApproval(
    brandId: string,
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    opts?: { feedback?: string; remember?: boolean }
  ): Promise<boolean>
  // answers keyed by question id, several picks joined with ", "
  respondUserInput(brandId: string, threadId: string, requestId: string, answers: Record<string, string>): Promise<boolean>
  // input into the running turn. falls back to the queue when the agent can't take it, and
  // to a normal send when nothing is running
  steer(brandId: string, threadId: string, text: string, agentId: string): Promise<SteerResult>
  // waits for the running turn, then goes out as its own message
  queue(brandId: string, threadId: string, text: string, agentId: string): Promise<QueuedMessage[]>
  unqueue(brandId: string, threadId: string, queueId: string): Promise<QueuedMessage[]>
  // moves a queued message into the running turn
  steerQueued(brandId: string, threadId: string, queueId: string): Promise<SteerResult>
  listQueue(brandId: string, threadId: string): Promise<QueuedMessage[]>
  getPermissionMode(brandId: string, threadId: string | null): Promise<PermissionMode>
  // threadId null sets the default for new threads
  setPermissionMode(brandId: string, threadId: string | null, mode: PermissionMode): Promise<PermissionMode>
  // pending approvals and questions for a thread, e.g. after the window reloaded
  pending(brandId: string, threadId: string): Promise<{ approvals: ApprovalRecord[]; inputs: UserInputRequest[] }>
  onProviderEvent(fn: (event: ProviderChatEvent) => void): () => void
}
