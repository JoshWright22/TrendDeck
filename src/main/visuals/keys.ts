import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { MediaSourceKeys, ProviderId } from '@shared/visuals'

// the free Pexels and Pixabay keys, sealed with safeStorage in visuals/keys.json. they go into
// search requests from main and nowhere else: the window only learns whether one is saved, the
// agent never sees one, and redaction knows the values (see setupVisuals)

type KeyName = 'pexels' | 'pixabay'
const file = (): string => join(app.getPath('userData'), 'visuals', 'keys.json')
const open = new Map<KeyName, string>()
let loaded = false

const canStore = (): boolean =>
  safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))

async function load(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>
    for (const k of ['pexels', 'pixabay'] as const) {
      const v = raw[k]
      if (typeof v !== 'string' || !v.startsWith('enc:')) continue
      try {
        open.set(k, safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')))
      } catch {
        // sealed on another account or machine, as good as not saved
      }
    }
  } catch {
    // none saved
  }
}

async function persist(): Promise<void> {
  const out: Record<string, string> = {}
  for (const [k, v] of open) out[k] = `enc:${safeStorage.encryptString(v).toString('base64')}`
  await fs.mkdir(join(app.getPath('userData'), 'visuals'), { recursive: true })
  await fs.writeFile(`${file()}.tmp`, JSON.stringify(out), { mode: 0o600 })
  await fs.rename(`${file()}.tmp`, file())
}

export async function keyState(): Promise<MediaSourceKeys> {
  await load()
  return { pexels: open.has('pexels'), pixabay: open.has('pixabay'), canStore: canStore() }
}

export async function setKey(name: unknown, key: unknown): Promise<MediaSourceKeys> {
  if (name !== 'pexels' && name !== 'pixabay') throw new Error('Pick Pexels or Pixabay.')
  const v = typeof key === 'string' ? key.trim() : ''
  if (!v) throw new Error('Paste the key first.')
  if (v.length > 200 || /\s/.test(v)) throw new Error("That doesn't look like a key.")
  if (!canStore()) throw new Error("Windows can't encrypt keys for TrendDeck right now, so the key wasn't saved.")
  await load()
  open.set(name, v)
  await persist()
  return keyState()
}

export async function clearKey(name: unknown): Promise<MediaSourceKeys> {
  if (name !== 'pexels' && name !== 'pixabay') throw new Error('Pick Pexels or Pixabay.')
  await load()
  open.delete(name)
  await persist()
  return keyState()
}

export async function keyFor(p: ProviderId): Promise<string> {
  await load()
  return p === 'pexels' || p === 'pixabay' ? (open.get(p) ?? '') : ''
}

// for redaction, sync: whatever is open now
export function keyValues(): string[] {
  return [...open.values()]
}

export async function loadKeys(): Promise<void> {
  await load()
}
