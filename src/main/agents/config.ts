import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ID_PATTERN, isHttpUrl } from '@shared/types'
import { ACCOUNT_ENV, AUTO_AGENT, baseAgentId, isAccountId } from '@shared/agents'
import type { AgentAccount, AgentConfig, CustomAgent, CustomAgentInput } from '@shared/chat'

// custom agents live in their own file so api keys never end up in trenddeck.json
// or get sent to the window. keys are encrypted with the os keychain when it's there

interface StoredAgent extends Omit<CustomAgent, 'hasKey'> {
  // "enc:" + base64 when safeStorage works, "raw:" + key when it doesn't
  key: string
}

export interface Stored {
  defaultAgentId: string | null
  custom: StoredAgent[]
  // extra accounts of claude and codex, the folder is all that's kept, never what's in it
  accounts: AgentAccount[]
  rank: string[]
  autoOff: string[]
}

const EMPTY: Stored = { defaultAgentId: null, custom: [], accounts: [], rank: [], autoOff: [] }

function file(): string {
  return join(app.getPath('userData'), 'agents.json')
}

let cache: Stored | null = null

const agentIds = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 80))].slice(0, 100) : []

// older files only have defaultAgentId and custom, the rest starts empty
export function clean(raw: unknown): Stored {
  const d = (raw ?? {}) as Partial<Stored>
  const custom = Array.isArray(d.custom)
    ? d.custom.flatMap((a): StoredAgent[] => {
        if (!a || typeof a.id !== 'string' || !ID_PATTERN.test(a.id)) return []
        if (a.kind !== 'command' && a.kind !== 'api') return []
        const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
        return [
          {
            id: a.id,
            name: str(a.name, 40) || 'Custom agent',
            kind: a.kind,
            command: str(a.command, 2000),
            baseUrl: str(a.baseUrl, 500),
            model: str(a.model, 200),
            key: str(a.key, 4000)
          }
        ]
      })
    : []
  const defaultAgentId =
    typeof d.defaultAgentId === 'string' && d.defaultAgentId.length < 80 ? d.defaultAgentId : null
  const accounts = Array.isArray(d.accounts)
    ? d.accounts.flatMap((a): AgentAccount[] => {
        if (!a || typeof a.id !== 'string' || !isAccountId(a.id)) return []
        if (typeof a.folder !== 'string' || !a.folder || a.folder.length > 500 || !isAbsolute(a.folder)) return []
        const name = typeof a.name === 'string' ? a.name.trim().slice(0, 40) : ''
        return [{ id: a.id, name: name || 'Another account', folder: a.folder }]
      })
    : []
  return { defaultAgentId, custom, accounts, rank: agentIds(d.rank), autoOff: agentIds(d.autoOff) }
}

async function load(): Promise<Stored> {
  if (cache) return cache
  try {
    cache = clean(JSON.parse(await fs.readFile(file(), 'utf8')))
  } catch {
    cache = { ...EMPTY }
  }
  return cache
}

async function save(next: Stored): Promise<void> {
  cache = next
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, file())
}

function seal(key: string): string {
  if (!key) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(key).toString('base64')}`
  }
  return `raw:${key}`
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

function toPublic(s: Stored): AgentConfig {
  return {
    defaultAgentId: s.defaultAgentId,
    custom: s.custom.map(({ key, ...a }) => ({ ...a, hasKey: key !== '' })),
    accounts: s.accounts.map((a) => ({ ...a })),
    rank: [...s.rank],
    autoOff: [...s.autoOff]
  }
}

// drops an agent from the default, the rank and the auto list
function forget(s: Stored, id: string): Stored {
  return {
    ...s,
    defaultAgentId: s.defaultAgentId === id ? null : s.defaultAgentId,
    rank: s.rank.filter((r) => r !== id),
    autoOff: s.autoOff.filter((r) => r !== id)
  }
}

export async function getConfig(): Promise<AgentConfig> {
  return toPublic(await load())
}

export async function getCustom(id: string): Promise<(CustomAgent & { apiKey: string }) | null> {
  const s = await load()
  const a = s.custom.find((c) => c.id === id)
  if (!a) return null
  const { key, ...rest } = a
  return { ...rest, hasKey: key !== '', apiKey: unseal(key) }
}

export async function saveCustom(input: CustomAgentInput): Promise<AgentConfig> {
  const s = await load()
  const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : ''
  if (!id.startsWith('custom-')) throw new Error('bad agent id')
  if (input.kind === 'api' && !isHttpUrl(input.baseUrl)) throw new Error('The API URL has to start with http:// or https://')
  if (input.kind === 'command' && !input.command.trim()) throw new Error('Add a command to run')
  const old = s.custom.find((c) => c.id === id)
  let key = old?.key ?? ''
  if (input.clearKey) key = ''
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) key = seal(input.apiKey.trim())
  const [next] = clean({
    custom: [
      {
        id,
        name: String(input.name ?? '').trim(),
        kind: input.kind,
        command: String(input.command ?? '').trim(),
        baseUrl: String(input.baseUrl ?? '').trim().replace(/\/+$/, ''),
        model: String(input.model ?? '').trim(),
        key
      }
    ]
  }).custom
  if (!next) throw new Error('bad agent')
  const custom = old ? s.custom.map((c) => (c.id === id ? next : c)) : [...s.custom, next]
  await save({ ...s, custom })
  return toPublic(cache as Stored)
}

export async function removeCustom(id: string): Promise<AgentConfig> {
  const s = await load()
  await save(forget({ ...s, custom: s.custom.filter((c) => c.id !== id) }, id))
  return toPublic(cache as Stored)
}

export async function setDefault(id: string | null): Promise<AgentConfig> {
  const s = await load()
  await save({ ...s, defaultAgentId: typeof id === 'string' ? id.slice(0, 80) : null })
  return toPublic(cache as Stored)
}

// the order auto tries agents in. the first time it's set, new chats start on auto
export async function setRank(rank: unknown, autoOff: unknown): Promise<AgentConfig> {
  const s = await load()
  const first = s.rank.length === 0
  const next = { ...s, rank: agentIds(rank), autoOff: agentIds(autoOff) }
  if (first && next.rank.length) next.defaultAgentId = AUTO_AGENT
  await save(next)
  return toPublic(cache as Stored)
}

export async function getAccount(id: string): Promise<AgentAccount | null> {
  if (!isAccountId(id)) return null
  return (await load()).accounts.find((a) => a.id === id) ?? null
}

// the env var that points the cli at the account's folder, empty for the usual one
export async function accountEnv(id: string): Promise<Record<string, string>> {
  const a = await getAccount(id)
  const key = ACCOUNT_ENV[baseAgentId(id)]
  return a && key ? { [key]: a.folder } : {}
}

export async function saveAccount(input: AgentAccount): Promise<AgentConfig> {
  const s = await load()
  const [next] = clean({ accounts: [input] }).accounts
  if (!next) throw new Error('Pick a folder for this account')
  if (s.accounts.some((a) => a.id !== next.id && a.folder.toLowerCase() === next.folder.toLowerCase())) {
    throw new Error('Another account already uses that folder')
  }
  const old = s.accounts.some((a) => a.id === next.id)
  const accounts = old ? s.accounts.map((a) => (a.id === next.id ? next : a)) : [...s.accounts, next]
  await save({ ...s, accounts })
  return toPublic(cache as Stored)
}

export async function removeAccount(id: string): Promise<AgentConfig> {
  const s = await load()
  await save(forget({ ...s, accounts: s.accounts.filter((a) => a.id !== id) }, id))
  return toPublic(cache as Stored)
}
