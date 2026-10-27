import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { McpToolDef } from '../craft/rules'
import { cleanServers, cleanToolDefs, pairValues, secretsOf, type StoredServer } from './config'

// your MCP servers in mcp-servers/servers.json, each one's last tool list in tools-<id>.json so
// agents see the tools without the server running. secret env and header values are sealed
// with the os keychain ("enc:"), or kept as "raw:" when there's none

const dir = (): string => join(app.getPath('userData'), 'mcp-servers')
const serversFile = (): string => join(dir(), 'servers.json')
const toolsFile = (id: string): string => join(dir(), `tools-${id}.json`)

let cache: StoredServer[] | null = null
let queue: Promise<void> = Promise.resolve()
// decrypted once per save, so redaction and starting a server don't unseal every time
let opened = new Map<string, { env: Record<string, string>; headers: Record<string, string>; secrets: string[] }>()
const toolCache = new Map<string, { at: number; defs: McpToolDef[] }>()

export function seal(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  return `raw:${plain}`
}

function unseal(stored: string): string {
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  return stored.startsWith('raw:') ? stored.slice(4) : ''
}

function reopen(list: StoredServer[]): void {
  const next = new Map<string, { env: Record<string, string>; headers: Record<string, string>; secrets: string[] }>()
  for (const s of list) {
    next.set(s.id, { env: pairValues(s.env, unseal), headers: pairValues(s.headers, unseal), secrets: secretsOf(s, unseal) })
  }
  opened = next
}

export async function loadServers(): Promise<StoredServer[]> {
  if (cache) return cache
  let list: StoredServer[] = []
  try {
    list = cleanServers(JSON.parse(await fs.readFile(serversFile(), 'utf8')))
  } catch {
    // no file yet
  }
  // a save that ran while this was reading wins
  if (cache) return cache
  cache = list
  reopen(list)
  for (const s of list) await loadToolCache(s.id)
  return cache
}

// what's loaded right now, empty before the first load
export function serversNow(): StoredServer[] {
  return cache ?? []
}

export function serverNow(id: string): StoredServer | null {
  return serversNow().find((s) => s.id === id) ?? null
}

export function saveServers(next: StoredServer[]): Promise<void> {
  cache = next
  reopen(next)
  const text = JSON.stringify({ servers: next }, null, 2)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(`${serversFile()}.tmp`, text, 'utf8')
    await fs.rename(`${serversFile()}.tmp`, serversFile())
  }
  queue = queue.then(run, run)
  return queue
}

// the env vars and headers with secrets opened, only for starting or calling the server
export function openedPairs(id: string): { env: Record<string, string>; headers: Record<string, string> } {
  const o = opened.get(id)
  return { env: { ...(o?.env ?? {}) }, headers: { ...(o?.headers ?? {}) } }
}

export function serverSecrets(id: string): string[] {
  return opened.get(id)?.secrets ?? []
}

// every server's secret values, for the gateway's redaction
export function allSecrets(): string[] {
  return [...opened.values()].flatMap((o) => o.secrets)
}

// ---- tool lists ----

async function loadToolCache(id: string): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(toolsFile(id), 'utf8')) as { at?: unknown; tools?: unknown }
    const defs = cleanToolDefs(raw.tools)
    toolCache.set(id, { at: typeof raw.at === 'number' ? raw.at : 0, defs })
  } catch {
    toolCache.delete(id)
  }
}

export function cachedTools(id: string): { at: number; defs: McpToolDef[] } | null {
  return toolCache.get(id) ?? null
}

export function storeTools(id: string, defs: McpToolDef[]): Promise<void> {
  const entry = { at: Date.now(), defs }
  toolCache.set(id, entry)
  const text = JSON.stringify({ at: entry.at, tools: defs })
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(`${toolsFile(id)}.tmp`, text, 'utf8')
    await fs.rename(`${toolsFile(id)}.tmp`, toolsFile(id))
  }
  queue = queue.then(run, run)
  return queue.catch(() => {})
}

export function dropTools(id: string): Promise<void> {
  toolCache.delete(id)
  const run = (): Promise<void> => fs.rm(toolsFile(id), { force: true })
  queue = queue.then(run, run)
  return queue.catch(() => {})
}
