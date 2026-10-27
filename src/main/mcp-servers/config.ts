// the pure rules for your own MCP servers: what a saved server looks like, checking what comes
// from the file and the window, which values are secret and what the window gets to see.
// no electron here, sealing is passed in, so config.test.ts runs it on its own
import { ID_PATTERN } from '@shared/types'
import {
  MCP_SERVER_NAME,
  looksSecret,
  type McpPairView,
  type McpServerKind,
  type McpServerStatus,
  type McpServerToolView,
  type McpServerView
} from '@shared/mcp-servers'
import { APPS } from '../craft/catalog'
import { gatewayName, type McpToolDef } from '../craft/rules'
import { isSecretKey } from '../gateway/redact'

// tool name prefixes TrendDeck uses itself
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...APPS.map((a) => a.id),
  'craft',
  'git',
  'storage',
  'pipeline',
  'run',
  'media',
  'review',
  'show',
  'suggest',
  'brand',
  'past',
  'remember',
  'style',
  'qc',
  'obs'
])

export const LIMITS = {
  label: 40,
  command: 1000,
  args: 64,
  arg: 4000,
  cwd: 500,
  pairs: 50,
  envKey: 128,
  headerKey: 128,
  value: 8000,
  url: 2000,
  tools: 300,
  toolName: 128,
  toolTitle: 200,
  toolDescription: 10_000,
  schemaChars: 200_000
} as const

// a saved env var or header. a secret's value is sealed ("enc:" or "raw:" + ...), "" when unset
export interface StoredPair {
  key: string
  value: string
  secret: boolean
}

export interface StoredServer {
  id: string
  label: string
  kind: McpServerKind
  command: string
  args: string[]
  cwd: string
  env: StoredPair[]
  url: string
  headers: StoredPair[]
  // brand id to on. only brands it's on for are kept
  brands: Record<string, true>
  trusted: boolean
  addedAt: number
}

export type Seal = (plain: string) => string

// a mistake in what you typed, the message goes to Settings as is
export class ConfigError extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// http token characters
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
// set by TrendDeck on every request, or by the transport
const RESERVED_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id'
])
// these would turn the child into something else
const RESERVED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'TRENDDECK_MCP_LAUNCH'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// starts out secret in the form: anything the gateway's redaction would blank, plus *_KEY and so on
export function defaultSecret(key: string): boolean {
  return isSecretKey(key) || looksSecret(key)
}

export function nameProblem(name: string, taken: readonly string[]): string | null {
  if (!name) return 'Give the server a name.'
  if (!MCP_SERVER_NAME.test(name)) return 'The name can only use a to z and 0 to 9, start with a letter and be up to 20 long.'
  if (RESERVED_NAMES.has(name)) return `TrendDeck already uses "${name}" for its own tools, pick another name.`
  if (taken.includes(name)) return `You already have a server called ${name}.`
  return null
}

export function urlProblem(raw: string): string | null {
  const v = raw.trim()
  if (!v) return 'Add the server address.'
  if (v.length > LIMITS.url) return 'That address is too long.'
  if (CONTROL.test(v)) return "That address can't have line breaks in it."
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return "That doesn't look like a web address."
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The address has to start with http:// or https://'
  if (u.username || u.password) return "Don't put a login in the address, add it as a header instead."
  if (!u.hostname) return "That doesn't look like a web address."
  return null
}

function cwdProblem(v: string): string | null {
  if (!v) return null
  if (v.length > LIMITS.cwd || CONTROL.test(v)) return "That folder path doesn't look right."
  if (!/^[a-zA-Z]:[\\/]|^\\\\[^\\]|^\//.test(v)) return 'The folder to run in has to be a full path, like C:\\Users\\you\\folder.'
  return null
}

// windows env names and http header names don't care about case
function sameKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function pairKeyProblem(kind: 'env' | 'header', key: string): string | null {
  if (kind === 'env') {
    if (key.length > LIMITS.envKey || !ENV_KEY.test(key)) return `${key || 'An empty name'} isn't a valid variable name, use letters, numbers and _.`
    if (RESERVED_ENV.has(key.toUpperCase())) return `TrendDeck sets ${key} itself.`
    return null
  }
  if (key.length > LIMITS.headerKey || !HEADER_KEY.test(key)) return `${key || 'An empty name'} isn't a valid header name.`
  if (RESERVED_HEADERS.has(key.toLowerCase())) return `TrendDeck sets the ${key} header itself.`
  return null
}

function valueProblem(kind: 'env' | 'header', key: string, value: string): string | null {
  if (value.length > LIMITS.value) return `The value for ${key} is too long.`
  if (value.includes('\0')) return `The value for ${key} has a character that can't be used.`
  if (kind === 'header' && /[\r\n]/.test(value)) return `The value for ${key} can't have line breaks in it.`
  return null
}

const sealed = (v: string): boolean => v === '' || v.startsWith('enc:') || v.startsWith('raw:')

// the env vars or headers from the window, merged with what's saved. a secret left empty keeps
// its saved value, clear forgets it. rows left out are dropped
export function mergePairs(kind: 'env' | 'header', raw: unknown, old: readonly StoredPair[], seal: Seal): StoredPair[] {
  if (raw !== undefined && !Array.isArray(raw)) throw new ConfigError('bad list')
  const list = (raw ?? []) as unknown[]
  const out: StoredPair[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new ConfigError('bad list')
    const p = item as Record<string, unknown>
    const key = str(p.key).trim()
    const value = str(p.value)
    const secret = p.secret === true
    // an empty row is skipped
    if (!key && !value) continue
    const why = pairKeyProblem(kind, key) ?? valueProblem(kind, key, value)
    if (why) throw new ConfigError(why)
    if (out.some((o) => sameKey(o.key, key))) throw new ConfigError(`${key} is in the list twice.`)
    if (out.length >= LIMITS.pairs) throw new ConfigError(`Up to ${LIMITS.pairs} ${kind === 'env' ? 'variables' : 'headers'}.`)
    if (!secret) {
      out.push({ key, value, secret: false })
      continue
    }
    const prev = old.find((o) => o.secret && sameKey(o.key, key))
    let stored: string
    if (value !== '') stored = seal(value)
    else if (p.clear === true) stored = ''
    else stored = prev?.value ?? ''
    out.push({ key, value: stored, secret: true })
  }
  return out
}

function cleanArgs(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ConfigError('bad arguments')
  if (raw.length > LIMITS.args) throw new ConfigError(`Up to ${LIMITS.args} arguments.`)
  return raw.map((a) => {
    if (typeof a !== 'string') throw new ConfigError('bad arguments')
    if (a.length > LIMITS.arg) throw new ConfigError('One of the arguments is too long.')
    if (/[\0\r\n]/.test(a)) throw new ConfigError("Arguments can't have line breaks in them, put each one on its own line.")
    return a
  })
}

// a server from Settings, checked, with its secrets sealed. old is the saved one when editing.
// taken is every other saved name. throws ConfigError with a plain sentence
export function applyInput(
  raw: unknown,
  old: StoredServer | null,
  taken: readonly string[],
  seal: Seal,
  now = Date.now()
): StoredServer {
  if (!raw || typeof raw !== 'object') throw new ConfigError('bad server')
  const input = raw as Record<string, unknown>
  const id = str(input.id).trim()
  if (input.create === true) {
    const why = nameProblem(id, taken)
    if (why) throw new ConfigError(why)
    if (old) throw new ConfigError(`You already have a server called ${id}.`)
  } else if (!old || old.id !== id) {
    throw new ConfigError("That server isn't saved anymore.")
  }
  const kind = input.kind === 'http' ? 'http' : input.kind === 'stdio' ? 'stdio' : null
  if (!kind) throw new ConfigError('Pick how TrendDeck reaches the server.')
  const label = str(input.label).trim().replace(/\s+/g, ' ') || id
  if (label.length > LIMITS.label) throw new ConfigError(`Keep the label under ${LIMITS.label} characters.`)
  if (CONTROL.test(label)) throw new ConfigError("The label can't have line breaks in it.")

  let command = ''
  let args: string[] = []
  let cwd = ''
  let env: StoredPair[] = []
  let url = ''
  let headers: StoredPair[] = []
  if (kind === 'stdio') {
    command = str(input.command).trim()
    if (!command) throw new ConfigError('Add the command that starts the server, like npx.')
    if (command.length > LIMITS.command) throw new ConfigError('The command is too long.')
    if (CONTROL.test(command)) throw new ConfigError("The command can't have line breaks in it.")
    if (command.includes('"')) throw new ConfigError("Leave the quotes out of the command, TrendDeck adds them when it's needed.")
    args = cleanArgs(input.args)
    cwd = str(input.cwd).trim()
    const why = cwdProblem(cwd)
    if (why) throw new ConfigError(why)
    env = mergePairs('env', input.env, old?.env ?? [], seal)
  } else {
    url = str(input.url).trim()
    const why = urlProblem(url)
    if (why) throw new ConfigError(why)
    headers = mergePairs('header', input.headers, old?.headers ?? [], seal)
  }

  // a new one starts on for the brand it was added from only, and untrusted
  const from = str(input.brandId)
  const brands: Record<string, true> = old ? { ...old.brands } : ID_PATTERN.test(from) ? { [from]: true } : {}
  return {
    id,
    label,
    kind,
    command,
    args,
    cwd,
    env,
    url,
    headers,
    brands,
    trusted: old?.trusted ?? false,
    addedAt: old?.addedAt ?? now
  }
}

// a pair read back from servers.json, bad ones dropped
function filePairs(kind: 'env' | 'header', raw: unknown): StoredPair[] {
  if (!Array.isArray(raw)) return []
  const out: StoredPair[] = []
  for (const item of raw.slice(0, LIMITS.pairs)) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const key = str(p.key)
    const value = str(p.value)
    const secret = p.secret === true
    if (pairKeyProblem(kind, key) || valueProblem(kind, key, value)) continue
    if (secret && !sealed(value)) continue
    if (out.some((o) => sameKey(o.key, key))) continue
    out.push({ key, value, secret })
  }
  return out
}

// one server from servers.json, null when it can't be used
export function cleanServer(raw: unknown): StoredServer | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = str(s.id)
  if (nameProblem(id, [])) return null
  const kind: McpServerKind | null = s.kind === 'http' ? 'http' : s.kind === 'stdio' ? 'stdio' : null
  if (!kind) return null
  const label = str(s.label).replace(CONTROL, ' ').trim().slice(0, LIMITS.label) || id
  const brands: Record<string, true> = {}
  if (s.brands && typeof s.brands === 'object' && !Array.isArray(s.brands)) {
    for (const [b, on] of Object.entries(s.brands as Record<string, unknown>)) if (on === true && ID_PATTERN.test(b)) brands[b] = true
  }
  const base = { id, label, kind, brands, trusted: s.trusted === true, addedAt: typeof s.addedAt === 'number' ? s.addedAt : 0 }
  if (kind === 'stdio') {
    const command = str(s.command).trim()
    if (!command || command.length > LIMITS.command || CONTROL.test(command) || command.includes('"')) return null
    let args: string[]
    try {
      args = cleanArgs(s.args)
    } catch {
      return null
    }
    const cwd = str(s.cwd)
    return { ...base, command, args, cwd: cwdProblem(cwd) ? '' : cwd, env: filePairs('env', s.env), url: '', headers: [] }
  }
  const url = str(s.url)
  if (urlProblem(url)) return null
  return { ...base, command: '', args: [], cwd: '', env: [], url, headers: filePairs('header', s.headers) }
}

export function cleanServers(raw: unknown): StoredServer[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers) ? (raw as { servers: unknown[] }).servers : []
  const out: StoredServer[] = []
  for (const item of list) {
    const s = cleanServer(item)
    if (s && !out.some((o) => o.id === s.id)) out.push(s)
  }
  return out
}

// ---- the server's tools ----

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

// a tools/list answer or the cache file, bad tools dropped
export function cleanToolDefs(raw: unknown): McpToolDef[] {
  if (!Array.isArray(raw)) return []
  const out: McpToolDef[] = []
  for (const item of raw) {
    if (out.length >= LIMITS.tools) break
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const name = str(t.name)
    if (!name || name.length > LIMITS.toolName || CONTROL.test(name)) continue
    const def: McpToolDef = { name }
    const title = str(t.title).replace(CONTROL, ' ').trim().slice(0, LIMITS.toolTitle)
    if (title) def.title = title
    const description = str(t.description).slice(0, LIMITS.toolDescription)
    if (description) def.description = description
    if (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)) {
      let size = Infinity
      try {
        size = JSON.stringify(t.inputSchema).length
      } catch {
        // circular, left out
      }
      if (size <= LIMITS.schemaChars) def.inputSchema = t.inputSchema as Record<string, unknown>
    }
    if (t.annotations && typeof t.annotations === 'object') {
      const a = t.annotations as Record<string, unknown>
      const ann: NonNullable<McpToolDef['annotations']> = {}
      const at = str(a.title).replace(CONTROL, ' ').trim().slice(0, LIMITS.toolTitle)
      if (at) ann.title = at
      for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        const b = bool(a[k])
        if (b !== undefined) ann[k] = b
      }
      def.annotations = ann
    }
    out.push(def)
  }
  return out
}

export interface ToolEntry {
  name: string
  def: McpToolDef
  risk: 'read' | 'edit'
  alwaysAsk: boolean
}

// the server's tools under their gateway names. read only tools read, the rest edit. a tool the
// server marks destructive asks every time. the spec says destructive is the default for tools
// that aren't read only, only an explicit true counts here or every unmarked tool would ask.
// two tools that end up with the same gateway name: the first one wins
export function toolEntries(serverId: string, defs: readonly McpToolDef[]): ToolEntry[] {
  const out: ToolEntry[] = []
  const seen = new Set<string>()
  for (const def of defs) {
    const name = gatewayName(serverId, def.name)
    if (seen.has(name)) continue
    seen.add(name)
    const risk = def.annotations?.readOnlyHint === true ? 'read' : 'edit'
    out.push({ name, def, risk, alwaysAsk: def.annotations?.destructiveHint === true })
  }
  return out
}

// ---- what the window sees ----

function pairView(p: StoredPair): McpPairView {
  return p.secret ? { key: p.key, secret: true, set: p.value !== '' } : { key: p.key, secret: false, value: p.value }
}

export function toView(
  s: StoredServer,
  brandId: string,
  live: { status: McpServerStatus; error: string },
  tools: { at: number; defs: readonly McpToolDef[] } | null
): McpServerView {
  const list: McpServerToolView[] = toolEntries(s.id, tools?.defs ?? []).map((t) => ({
    name: t.name,
    tool: t.def.name,
    title: t.def.title ?? t.def.annotations?.title ?? t.def.name,
    risk: t.risk,
    alwaysAsk: t.alwaysAsk
  }))
  return {
    id: s.id,
    label: s.label,
    kind: s.kind,
    command: s.command,
    args: [...s.args],
    cwd: s.cwd,
    env: s.env.map(pairView),
    url: s.url,
    headers: s.headers.map(pairView),
    enabled: s.brands[brandId] === true,
    brandCount: Object.keys(s.brands).length,
    trusted: s.trusted,
    status: live.status,
    error: live.status === 'error' ? live.error : '',
    tools: list,
    toolsAt: tools ? tools.at : null
  }
}

// the env vars or headers to start or call the server with. unset secrets are left out
export function pairValues(pairs: readonly StoredPair[], unseal: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    if (!p.secret) out[p.key] = p.value
    else if (p.value) {
      const v = unseal(p.value)
      if (v) out[p.key] = v
    }
  }
  return out
}

// every secret value a server holds, for redaction
export function secretsOf(s: StoredServer, unseal: (v: string) => string): string[] {
  const out: string[] = []
  for (const p of [...s.env, ...s.headers]) {
    if (!p.secret || !p.value) continue
    const v = unseal(p.value)
    if (v) out.push(v)
  }
  return out
}
