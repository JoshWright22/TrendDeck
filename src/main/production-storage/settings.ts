import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { StorageSettings, StorageState } from '@shared/storage'
import { ID_PATTERN } from '@shared/types'
import { redactText } from '../gateway/redact'
import { broadcast } from '../gateway/wait'
import { executable, runProcess } from './process'
import { createArgs, parseRemotes, REMOTE_NAMES, remoteKind, RemoteInputError } from './remotes'
import { remoteDestination, StorageError } from './safety'

// Settings, Storage: per brand the default cloud folder and what happens to originals after a
// checked copy, plus setting up rclone remotes. keys go straight to rclone's own config, TrendDeck
// keeps only which kind each remote is (R2 looks like any s3 to rclone)

const dir = (): string => join(app.getPath('userData'), 'storage')
const settingsFile = (): string => join(dir(), 'settings.json')

interface File {
  brands: Record<string, Omit<StorageSettings, 'brandId'>>
  labels: Record<string, string>
}

let cache: File | null = null
let queue: Promise<unknown> = Promise.resolve()

async function load(): Promise<File> {
  if (cache) return cache
  const out: File = { brands: {}, labels: {} }
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Partial<File>
    for (const [id, s] of Object.entries(raw.brands ?? {})) if (ID_PATTERN.test(id)) out.brands[id] = clean(id, s)
    for (const [k, v] of Object.entries(raw.labels ?? {})) if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && typeof v === 'string') out.labels[k] = v.slice(0, 20)
  } catch {
    // nothing saved yet
  }
  cache = out
  return out
}

function clean(brandId: string, raw: unknown): Omit<StorageSettings, 'brandId'> {
  const s = (raw ?? {}) as Partial<StorageSettings>
  let defaultDestination = ''
  if (typeof s.defaultDestination === 'string' && s.defaultDestination.trim()) {
    try {
      defaultDestination = remoteDestination(s.defaultDestination.trim()).destination
    } catch {
      defaultDestination = ''
    }
  }
  void brandId
  return { defaultDestination, afterCopy: s.afterCopy === 'archive' ? 'archive' : 'keep' }
}

function persist(): Promise<void> {
  const text = JSON.stringify(cache ?? { brands: {}, labels: {} }, null, 2)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(`${settingsFile()}.tmp`, text, 'utf8')
    await fs.rename(`${settingsFile()}.tmp`, settingsFile())
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

export async function storageSettings(brandId: string): Promise<StorageSettings> {
  const f = await load()
  return { brandId, ...(f.brands[brandId] ?? clean(brandId, {})) }
}

export async function setStorageSettings(brandId: string, patch: unknown): Promise<StorageSettings> {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
  const f = await load()
  const cur = f.brands[brandId] ?? clean(brandId, {})
  const p = (patch ?? {}) as Partial<StorageSettings>
  if (typeof p.defaultDestination === 'string' && p.defaultDestination.trim()) remoteDestination(p.defaultDestination.trim())
  f.brands[brandId] = clean(brandId, { ...cur, ...p })
  await persist()
  broadcast('storage:changed', { brandId })
  return { brandId, ...f.brands[brandId] }
}

export async function dropStorageBrand(brandId: string): Promise<void> {
  const f = await load()
  if (!f.brands[brandId]) return
  delete f.brands[brandId]
  await persist()
}

// what TrendDeck set each remote up as, e.g. r2 for an s3 remote
export async function remoteLabels(): Promise<Record<string, string>> {
  return { ...(await load()).labels }
}

let connecting: string | null = null

export async function storageState(brandId: string): Promise<StorageState> {
  const settings = await storageSettings(brandId)
  const has = async (name: 'git' | 'rclone'): Promise<string | null> => executable(name).catch(() => null)
  const [rclone, git] = await Promise.all([has('rclone'), has('git')])
  const labels = (await load()).labels
  let remotes: StorageState['remotes'] = []
  if (rclone) {
    try {
      const out = await runProcess(rclone, ['listremotes', '--long'], app.getPath('temp'), { limit: 32 * 1024 })
      remotes = parseRemotes(out).flatMap((r) => {
        const kind = remoteKind(r, labels)
        return kind ? [{ name: r.name, kind, label: REMOTE_NAMES[kind] }] : []
      })
    } catch {
      remotes = []
    }
  }
  return { rclone: !!rclone, git: !!git, remotes, settings, connecting }
}

export async function addRemote(raw: unknown): Promise<{ ok: boolean; note: string }> {
  if (connecting) return { ok: false, note: `Still setting up ${connecting}. Finish signing in first.` }
  let made
  try {
    made = createArgs(raw)
  } catch (err) {
    return { ok: false, note: err instanceof RemoteInputError ? err.message : 'Check the details and try again.' }
  }
  let binary: string
  try {
    binary = await executable('rclone')
  } catch (err) {
    return { ok: false, note: err instanceof StorageError ? err.message : 'Install rclone first.' }
  }
  const existing = parseRemotes(await runProcess(binary, ['listremotes', '--long'], app.getPath('temp'), { limit: 32 * 1024 }).catch(() => ''))
  if (existing.some((r) => r.name.toLowerCase() === made.name.toLowerCase())) return { ok: false, note: `There's already a remote called ${made.name}. Pick another name.` }
  connecting = made.name
  broadcast('storage:changed', {})
  try {
    // the browser sign in for drive, dropbox and onedrive can take a while
    await runProcess(binary, made.args, app.getPath('temp'), { timeout: 5 * 60_000, limit: 64 * 1024 })
    const f = await load()
    f.labels[made.name] = made.kind
    await persist()
    return { ok: true, note: `${REMOTE_NAMES[made.kind]} is set up as ${made.name}.` }
  } catch (err) {
    const msg = err instanceof StorageError ? err.message : 'rclone could not set it up.'
    return { ok: false, note: redactText(msg, made.secrets) }
  } finally {
    connecting = null
    broadcast('storage:changed', {})
  }
}

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

export function setupStorageSettings(): void {
  ipcMain.handle('storage:state', (e, brandId: unknown) => {
    if (!fromApp(e) || typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) throw new Error('bad storage call')
    return storageState(brandId)
  })
  ipcMain.handle('storage:settings', (e, brandId: unknown, patch: unknown) => {
    if (!fromApp(e) || typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) throw new Error('bad storage call')
    return setStorageSettings(brandId, patch)
  })
  ipcMain.handle('storage:add-remote', (e, input: unknown) => {
    if (!fromApp(e)) throw new Error('bad storage call')
    return addRemote(input)
  })
}
