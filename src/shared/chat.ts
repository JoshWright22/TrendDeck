// chat types used by the main process, the preload and the chat view

import type {
  ApprovalRecord,
  PermissionMode,
  PlanStep,
  ProviderCapabilities,
  ProviderKind,
  QueuedMessage
} from './providers'

export type AgentKind = 'cli' | 'command' | 'api'

export interface AgentInfo {
  // builtin ids are the cli name, custom ones start with custom-
  id: string
  name: string
  kind: AgentKind
  // false for a builtin cli that isn't on PATH
  installed: boolean
  // where it was found, or the api host
  detail: string
  // builtins only: the sign in command and where to get it
  setup?: string
  url?: string
  // models it can run, the first one is its own default
  models?: ModelOption[]
  // how hard it thinks, empty means the agent's own default
  efforts?: string[]
  // which adapter runs it and what that adapter can do
  provider?: ProviderKind
  capabilities?: ProviderCapabilities
  // false when we know it isn't signed in, null when we can't tell
  signedIn?: boolean | null
  // extra accounts: the builtin cli they run (claude, codex) and their config folder
  base?: string
  folder?: string
  // what keeps auto off it right now, and when that's over (null: once you sign in again)
  held?: { why: 'limit' | SkipReason; until: number | null }
}

export interface ModelOption {
  // empty means let the agent pick
  id: string
  label: string
  // effort levels this model takes, when the agent says
  efforts?: string[]
}

export interface CustomAgent {
  id: string
  name: string
  kind: 'command' | 'api'
  // command agents: the command line, {prompt} is swapped for the prompt, otherwise it goes in on stdin
  command: string
  // api agents: openai compatible base url, e.g. https://api.deepseek.com/v1
  baseUrl: string
  model: string
  // only ever true/false on the renderer side, the key itself stays in the main process
  hasKey: boolean
}

// what the renderer sends to save a custom agent, apiKey left empty keeps the old one
export interface CustomAgentInput extends Omit<CustomAgent, 'hasKey'> {
  apiKey: string
  clearKey?: boolean
}

// another sign in for a builtin cli, with its own config folder (CLAUDE_CONFIG_DIR, CODEX_HOME)
export interface AgentAccount {
  // claude@slug or codex@slug
  id: string
  name: string
  folder: string
}

export interface AgentConfig {
  // an agent id, 'auto' for the ranked pick, null for the first one found
  defaultAgentId: string | null
  custom: CustomAgent[]
  accounts: AgentAccount[]
  // agent ids in the order auto tries them, ones missing here go after in the usual order
  rank: string[]
  // agent ids auto never picks
  autoOff: string[]
}

// why auto went past an agent
export type SkipReason = 'rate_limit' | 'usage_limit' | 'auth'

export interface SkippedAgent {
  agentId: string
  reason: SkipReason
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error'

// anything with these four fields can go in the composer, e.g. from the media library
export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  // id is a media library id the agent can hand to upload_file
  media?: boolean
  // id is a visual (sketch, pasted or found image) the agent can look at with visual_get
  visual?: boolean
}

export type StepStatus = 'running' | 'done' | 'error'

// one line of the work log: a tool call, a page opened, a file read
export interface WorkStep {
  id: string
  kind: 'tool' | 'page' | 'file' | 'search' | 'command'
  label: string
  detail: string
  status: StepStatus
  startedAt: number
  endedAt?: number
}

export type Decision = 'approved' | 'declined'

export interface ThreadMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: number
  attachments?: Attachment[]
  // agent messages only
  agentId?: string
  model?: string
  status?: MessageStatus
  error?: string
  thinking?: string
  // set while the agent thinks but doesn't show its thoughts
  thinkingTokens?: number
  steps?: WorkStep[]
  // tokens the last run used, when the agent says
  contextTokens?: number
  finishedAt?: number
  // approve/decline picks for cards, keyed by the card's index in the reply
  decisions?: Record<string, Decision>
  // agent messages: tool approvals asked during the reply
  approvals?: ApprovalRecord[]
  // agent messages: the agent's latest plan or todo list
  plan?: PlanStep[]
  // user messages: sent into a reply that was still running
  steer?: boolean
  // agent messages: agents whose turns this agent got as a summary first
  handoffFrom?: string[]
  // agent messages: agents auto tried first that couldn't answer
  skipped?: SkippedAgent[]
}

export interface Thread {
  id: string
  title: string
  updatedAt: number
  // 'auto' picks the agent per reply from the ranked list
  agentId: string | null
  // model per agent id, empty or missing means the agent's default
  models?: Record<string, string>
  // effort per agent id, empty or missing means the agent's default
  efforts?: Record<string, string>
  // agent session to resume, per agent id
  sessions?: Record<string, string>
  // hash of the brand voice pack each agent's session last got, it's sent again when it changes
  voiceSent?: Record<string, string>
  // the TrendDeck version whose instructions each agent last got, a new one sends them again
  rulesSent?: Record<string, string>
  archived?: boolean
  // how much the agent may do without asking, missing means the brand's default
  permissionMode?: PermissionMode
  // messages waiting for the running reply to end
  queued?: QueuedMessage[]
  // last message id each agent's session has seen, so a switch back gets what it missed
  seen?: Record<string, string>
  messages: ThreadMessage[]
}

export interface ThreadSummary {
  id: string
  title: string
  updatedAt: number
  busy: boolean
  archived: boolean
  agentName?: string
  model?: string
  activity?: string
  preview?: string
}

// what's known about an agent's limits. null fields are unknown
export interface UsageWindow {
  label: string
  // 0 to 1
  used: number | null
  resetsAt: number | null
}

export interface AgentUsage {
  agentId: string
  windows: UsageWindow[]
  // where the numbers came from, or why there are none
  note: string
  seenAt: number | null
}

export type ChatEvent =
  | { type: 'delta'; brandId: string; threadId: string; messageId: string; text: string; kind?: 'text' | 'thinking' }
  | { type: 'step'; brandId: string; threadId: string; messageId: string; step: WorkStep }
  | { type: 'thinking-tokens'; brandId: string; threadId: string; messageId: string; tokens: number }
  | {
      type: 'done'
      brandId: string
      threadId: string
      messageId: string
      status: MessageStatus
      error?: string
    }
  | { type: 'threads'; brandId: string }

export interface SendOptions {
  model?: string
  effort?: string
  attachments?: Attachment[]
}

export interface SendResult {
  threadId: string
  messageId: string
}

export interface ChatApi {
  listAgents(rescan?: boolean): Promise<AgentInfo[]>
  getAgentConfig(): Promise<AgentConfig>
  saveCustomAgent(agent: CustomAgentInput): Promise<AgentConfig>
  removeCustomAgent(id: string): Promise<AgentConfig>
  setDefaultAgent(id: string | null): Promise<AgentConfig>
  // the auto order and which agents it may use
  setRank(rank: string[], autoOff: string[]): Promise<AgentConfig>
  saveAccount(account: AgentAccount): Promise<AgentConfig>
  removeAccount(id: string): Promise<AgentConfig>
  // folder names in your home folder that look like one, e.g. .claude-work. never reads inside them
  // fresh is a free name for a new one, like ~/.claude-2
  accountFolders(base: string): Promise<{ found: string[]; fresh: string }>
  // a folder picker, null when cancelled
  pickFolder(): Promise<string | null>
  // opens a console window running the cli's own login for that account
  signIn(agentId: string): Promise<void>
  listThreads(brandId: string): Promise<ThreadSummary[]>
  getThread(brandId: string, threadId: string): Promise<Thread | null>
  deleteThread(brandId: string, threadId: string): Promise<void>
  // saves the message, starts the agent and resolves right away, the reply comes in on events
  send(brandId: string, threadId: string | null, text: string, agentId: string, opts?: SendOptions): Promise<SendResult>
  stop(brandId: string, threadId: string): Promise<void>
  // runs the last reply again, or edits a user message, drops everything after it and runs again
  retry(brandId: string, threadId: string, agentId: string): Promise<SendResult>
  editAndResend(brandId: string, threadId: string, messageId: string, text: string, agentId: string): Promise<SendResult>
  renameThread(brandId: string, threadId: string, title: string): Promise<void>
  archiveThread(brandId: string, threadId: string, archived: boolean): Promise<void>
  // thread ids whose title or messages match
  searchThreads(brandId: string, query: string): Promise<string[]>
  setModel(brandId: string, threadId: string, agentId: string, model: string): Promise<void>
  setEffort(brandId: string, threadId: string, agentId: string, effort: string): Promise<void>
  // api agents ask their /models endpoint, clis come from a known list
  listModels(agentId: string): Promise<ModelOption[]>
  decide(brandId: string, threadId: string, messageId: string, card: string, decision: Decision): Promise<void>
  // never starts an agent run
  usage(): Promise<AgentUsage[]>
  onEvent(fn: (event: ChatEvent) => void): () => void
}

// the fenced block language agents use for cards in the chat
export const EMBED_LANG = 'trenddeck'
