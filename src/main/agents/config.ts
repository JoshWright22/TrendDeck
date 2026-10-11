import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN, isHttpUrl } from '@shared/types'
import type { AgentConfig, CustomAgent, CustomAgentInput } from '@shared/chat'

// custom agents live in their own file so api keys never end up in trenddeck.json
// or get sent to the window. keys are encrypted with the os keychain when it's there

interface StoredAgent extends Omit<CustomAgent, 'hasKey'> {
  // "enc:" + base64 when safeStorage works, "raw:" + key when it doesn't
  key: string
}

interface Stored {
  defaultAgentId: string | null
  custom: StoredAgent[]
}

function file(): string {
  return join(app.getPath('userData'), 'agents.json')
}

let cache: Stored | null = null

function clean(raw: unknown): Stored {
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
  return { defaultAgentId, custom }
}

async function load(): Promise<Stored> {
  if (cache) return cache
  try {
    cache = clean(JSON.parse(await fs.readFile(file(), 'utf8')))
  } catch {
    cache = { defaultAgentId: null, custom: [] }
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
    custom: s.custom.map(({ key, ...a }) => ({ ...a, hasKey: key !== '' }))
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
  const custom = s.custom.filter((c) => c.id !== id)
  const defaultAgentId = s.defaultAgentId === id ? null : s.defaultAgentId
  await save({ defaultAgentId, custom })
  return toPublic(cache as Stored)
}

export async function setDefault(id: string | null): Promise<AgentConfig> {
  const s = await load()
  await save({ ...s, defaultAgentId: typeof id === 'string' ? id.slice(0, 80) : null })
  return toPublic(cache as Stored)
}
