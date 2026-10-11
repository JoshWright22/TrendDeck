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

export interface ThreadMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: number
  // agent messages only
  agentId?: string
  status?: MessageStatus
  error?: string
}

export interface Thread {
  id: string
  title: string
  updatedAt: number
  agentId: string | null
  messages: ThreadMessage[]
}

export interface ThreadSummary {
  id: string
  title: string
  updatedAt: number
  busy: boolean
}

export type ChatEvent =
  | { type: 'delta'; brandId: string; threadId: string; messageId: string; text: string }
  | {
      type: 'done'
      brandId: string
      threadId: string
      messageId: string
      status: MessageStatus
      error?: string
    }
  | { type: 'threads'; brandId: string }

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
  send(brandId: string, threadId: string | null, text: string, agentId: string): Promise<SendResult>
  stop(brandId: string, threadId: string): Promise<void>
  onEvent(fn: (event: ChatEvent) => void): () => void
}

// the fenced block language agents use for cards in the chat
export const EMBED_LANG = 'trenddeck'
