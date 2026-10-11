// chat types used by the main process, the preload and the chat view

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
}

export interface ModelOption {
  // empty means let the agent pick
  id: string
  label: string
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

export interface AgentConfig {
  defaultAgentId: string | null
  custom: CustomAgent[]
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error'

// anything with these four fields can go in the composer, e.g. from the media library
export interface Attachment {
  id: string
  name: string
  type: string
  size: number
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
}

export interface Thread {
  id: string
  title: string
  updatedAt: number
  agentId: string | null
  // model per agent id, empty or missing means the agent's default
  models?: Record<string, string>
  // agent session to resume, per agent id
  sessions?: Record<string, string>
  archived?: boolean
  messages: ThreadMessage[]
}

export interface ThreadSummary {
  id: string
  title: string
  updatedAt: number
  busy: boolean
  archived: boolean
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
  // api agents ask their /models endpoint, clis come from a known list
  listModels(agentId: string): Promise<ModelOption[]>
  decide(brandId: string, threadId: string, messageId: string, card: string, decision: Decision): Promise<void>
  // never starts an agent run
  usage(): Promise<AgentUsage[]>
  onEvent(fn: (event: ChatEvent) => void): () => void
}

// the fenced block language agents use for cards in the chat
export const EMBED_LANG = 'trenddeck'
