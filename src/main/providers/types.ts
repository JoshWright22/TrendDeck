import type { AgentInfo, ModelOption, UsageWindow, WorkStep } from '@shared/chat'
import type {
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  PlanStep,
  ProviderCapabilities,
  ProviderKind,
  UserInputRequest
} from '@shared/providers'
import type { AgentSession } from '../mcp'

// one adapter per way of talking to an agent. the chat in agents/index.ts only ever goes
// through this, so a new provider is one file plus a line in registry.ts

// everything an adapter reports while a turn runs, in one stream
export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  // the agent is thinking but doesn't show its thoughts
  | { type: 'thinking-tokens'; tokens: number }
  // start and end share the step id, an update for the same id replaces it
  | { type: 'tool'; step: WorkStep }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'user-input-request'; request: UserInputRequest }
  | { type: 'plan'; plan: PlanStep[] }
  | { type: 'usage'; contextTokens?: number; inputTokens?: number; outputTokens?: number }
  | { type: 'limits'; windows: UsageWindow[] }
  // the agent's own session id, saved so the next turn resumes it
  | { type: 'session'; id: string }
  // a steered message went into the turn
  | { type: 'steered'; text: string }
  | { type: 'error'; message: string }
  | { type: 'turn-end'; status: 'done' | 'stopped' | 'error'; error?: string }

export interface ProviderHealth {
  installed: boolean
  // where it was found, or the api host
  detail: string
  // false when it's installed but we know it isn't signed in. null when we can't tell without starting a login
  signedIn: boolean | null
  note?: string
}

export interface SessionStart {
  agentId: string
  brandId: string
  threadId: string
  // the agent's own session id from an earlier turn
  resume?: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
  // the app's tool server for this turn. null for agents that get no tools (plain api agents)
  mcp: AgentSession | null
  emit: (event: ProviderEvent) => void
  // aborted when the user stops the reply or the app quits
  signal: AbortSignal
}

export interface TurnInput {
  // the whole prompt for the turn. adapters that keep a session get only the new part,
  // the chat decides which (see buildPrompt in agents/index.ts)
  text: string
  // agents that take messages instead of one prompt (api agents) get these three instead
  system?: string
  history?: { role: 'user' | 'agent'; text: string }[]
  message?: string
}

export interface ProviderSession {
  readonly agentId: string
  // runs one turn and resolves once it ended, the events go out through SessionStart.emit.
  // throws when the turn couldn't start at all
  sendTurn(input: TurnInput): Promise<void>
  // input into the running turn. false when the agent can't take it right now, the chat queues it then
  steer(text: string): Promise<boolean>
  // stops the running turn, the session stays usable
  interrupt(): Promise<void>
  respondToApproval(requestId: string, decision: ApprovalDecision, opts?: { feedback?: string; remember?: boolean }): boolean
  respondToUserInput(requestId: string, answers: Record<string, string>): boolean
  // takes effect from the next tool call where the agent supports it
  setPermissionMode(mode: PermissionMode): Promise<void>
  // the id to resume next turn, once the agent said
  sessionId(): string | undefined
  // kills whatever is left, idempotent
  close(): Promise<void>
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities
  // the agent ids this adapter runs
  handles(agentId: string): boolean
  // install and sign-in state. never starts a login or sends a prompt
  health(agentId: string): Promise<ProviderHealth>
  // live from the agent where it can list them, the known list otherwise
  listModels(agentId: string): Promise<ModelOption[]>
  // what the agent picker shows, null for ids this adapter doesn't know
  describe?(agentId: string): Promise<AgentInfo | null>
  startSession(start: SessionStart): Promise<ProviderSession>
}

// thrown when an adapter can't run on this machine (old cli without the needed mode), the
// chat falls back to the legacy cli adapter for that turn
export class ProviderUnavailable extends Error {}
