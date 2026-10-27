// your own MCP servers, added in Settings. main runs or connects to them and hands their tools to
// chat agents through the gateway as <server>_<tool>. see src/main/mcp-servers/.
// secret values go in once and never come back to the window

export type McpServerKind = 'stdio' | 'http'
export type McpServerStatus = 'off' | 'connecting' | 'ready' | 'error'

// a short id, no underscores so <server>_<tool> always splits the same way
export const MCP_SERVER_NAME = /^[a-z][a-z0-9]{0,19}$/

// a saved env var or header as the window sees it. a secret only says whether it's set
export type McpPairView = { key: string; secret: false; value: string } | { key: string; secret: true; set: boolean }

export interface McpPairInput {
  key: string
  // for a secret, empty keeps the saved value
  value: string
  secret: boolean
  // forgets a saved secret, the key stays with no value
  clear?: boolean
}

export interface McpServerToolView {
  // what agents call it, <server>_<tool>
  name: string
  // the server's own name for it
  tool: string
  title: string
  risk: 'read' | 'edit'
  // asks every time, the server says it can destroy things
  alwaysAsk: boolean
}

export interface McpServerView {
  id: string
  label: string
  kind: McpServerKind
  command: string
  args: string[]
  cwd: string
  env: McpPairView[]
  url: string
  headers: McpPairView[]
  // on for the brand the list was asked for
  enabled: boolean
  // how many brands it's on for
  brandCount: number
  // false: every call asks first
  trusted: boolean
  status: McpServerStatus
  // short and redacted, empty unless status is error
  error: string
  tools: McpServerToolView[]
  // when the tool list was last read from the server, null if never
  toolsAt: number | null
}

export interface McpServerInput {
  // the name, also its id. can't change once saved
  id: string
  // adding a new one, the name has to be free
  create: boolean
  label: string
  kind: McpServerKind
  command: string
  args: string[]
  cwd: string
  env: McpPairInput[]
  url: string
  headers: McpPairInput[]
  // the brand it's added from, it starts on for that one only
  brandId?: string
}

export type McpSaveResult = { ok: true; server: McpServerView } | { ok: false; error: string }

export interface McpTestResult {
  ok: boolean
  error: string
  tools: number
}

export interface McpServerPreset {
  key: string
  // the name it's added as, a number goes on the end when it's taken
  name: string
  label: string
  blurb: string
  // what you need for it, e.g. your own API key
  note: string
  kind: McpServerKind
  command: string
  args: string[]
  env: McpPairInput[]
  url: string
  headers: McpPairInput[]
}

// stands in for the brand's projects folder in a preset, main puts the real path in
export const PROJECTS_FOLDER = '{projects}'

export const MCP_PRESETS: McpServerPreset[] = [
  {
    key: 'files',
    name: 'files',
    label: 'Project files',
    blurb: "Reads and writes files in this brand's projects folder, nothing outside it.",
    note: 'Needs Node.js.',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', PROJECTS_FOLDER],
    env: [],
    url: '',
    headers: []
  },
  {
    key: 'fetch',
    name: 'fetch',
    label: 'Fetch',
    blurb: 'Fetches a web page and gives it back as text.',
    note: 'Needs uv installed (the uvx command).',
    kind: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    url: '',
    headers: []
  },
  {
    key: 'browser',
    name: 'browser',
    label: 'Browser',
    blurb: 'Opens its own browser window and clicks, types and reads pages in it. Your brand tabs stay separate.',
    note: 'Needs Node.js.',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: [],
    url: '',
    headers: []
  },
  {
    key: 'youtube',
    name: 'youtube',
    label: 'YouTube data',
    blurb: 'Searches YouTube and reads video, channel, comment and transcript data.',
    note: 'Needs Node.js and your own YouTube Data API key.',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', 'youtube-data-mcp-server'],
    env: [{ key: 'YOUTUBE_API_KEY', value: '', secret: true }],
    url: '',
    headers: []
  },
  {
    key: 'memory',
    name: 'memory',
    label: 'Memory',
    blurb: "A small knowledge graph agents can save facts to and look up later, kept in this brand's projects folder.",
    note: 'Needs Node.js.',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [{ key: 'MEMORY_FILE_PATH', value: `${PROJECTS_FOLDER}\\memory.jsonl`, secret: false }],
    url: '',
    headers: []
  }
]

// env and header names that start out secret. the same words the gateway's redaction blanks,
// plus names ending in key, pat or pass
const SECRET_PART =
  /pass(word|wd|phrase)|secret|token|cookie|authori[sz]ation|api[-_]?key|apikey|credential|private[-_]?key|session[-_]?id|sessionid|bearer|csrf|xsrf/i
const SECRET_END = /(^|[-_])(key|keys|auth|pwd|pin|pat|pass|sig|signature)$/i

export function looksSecret(key: string): boolean {
  return SECRET_PART.test(key) || SECRET_END.test(key)
}

export interface McpServersApi {
  list(brandId: string): Promise<McpServerView[]>
  save(input: McpServerInput): Promise<McpSaveResult>
  remove(id: string): Promise<void>
  setEnabled(id: string, brandId: string, on: boolean): Promise<void>
  setTrusted(id: string, on: boolean): Promise<void>
  // starts or reaches the server and reads its tools again
  test(id: string): Promise<McpTestResult>
  presets(brandId: string): Promise<McpServerPreset[]>
  onChanged(fn: () => void): () => void
}

declare global {
  interface Window {
    trenddeckMcpServers: McpServersApi
  }
}
