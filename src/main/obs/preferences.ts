import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ObsConnectionInput, ObsPreferences, ObsRecordingSettings } from '@shared/obs'
import { ID_PATTERN } from '@shared/types'
import { getData } from '../store'
import { normalizeEndpoint } from './protocol'
import { cleanSettings, loadSettings } from './rules'

interface Saved { endpoint: string; password?: string; recording: ObsRecordingSettings }

export function assertBrand(brandId: unknown): asserts brandId is string {
  if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId) || !getData()?.brands.some((brand) => brand.id === brandId)) {
    throw new Error('No brand with that id')
  }
}

function file(brandId: string): string {
  assertBrand(brandId)
  return join(app.getPath('userData'), 'obs', `${brandId}.json`)
}

async function read(brandId: string): Promise<Saved> {
  try {
    const saved = JSON.parse(await fs.readFile(file(brandId), 'utf8')) as Saved
    return {
      endpoint: normalizeEndpoint(saved.endpoint),
      password: typeof saved.password === 'string' ? saved.password : undefined,
      recording: loadSettings(saved.recording)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { endpoint: 'ws://127.0.0.1:4455/', recording: loadSettings(null) }
    throw new Error('Cannot read OBS preferences; check the brand and OBS settings file')
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))) {
    throw new Error('OS keychain encryption is unavailable; OBS passwords will not be stored')
  }
}

export async function obsPreferences(brandId: string): Promise<ObsPreferences> {
  const saved = await read(brandId)
  return { endpoint: saved.endpoint, hasPassword: !!saved.password, recording: saved.recording }
}

export async function recordingSettings(brandId: string): Promise<ObsRecordingSettings> {
  return (await read(brandId)).recording
}

async function write(brandId: string, saved: Saved): Promise<void> {
  const target = file(brandId)
  await fs.mkdir(join(app.getPath('userData'), 'obs'), { recursive: true })
  await fs.writeFile(`${target}.tmp`, JSON.stringify(saved), { mode: 0o600 })
  await fs.rename(`${target}.tmp`, target)
}

// one save at a time per brand, so the connection and the recording settings don't race
const saving = new Map<string, Promise<unknown>>()
function serial<T>(brandId: string, fn: () => Promise<T>): Promise<T> {
  const next = (saving.get(brandId) ?? Promise.resolve()).then(fn, fn)
  saving.set(brandId, next.catch(() => {}))
  return next
}

export function saveRecordingSettings(brandId: string, patch: unknown): Promise<ObsPreferences> {
  return serial(brandId, async () => {
    const saved = await read(brandId)
    saved.recording = cleanSettings(saved.recording, patch)
    await write(brandId, saved)
    return { endpoint: saved.endpoint, hasPassword: !!saved.password, recording: saved.recording }
  })
}

export async function obsCredentials(brandId: string): Promise<{ endpoint: string; password?: string }> {
  const saved = await read(brandId)
  if (!saved.password) return { endpoint: saved.endpoint }
  requireEncryption()
  try { return { endpoint: saved.endpoint, password: safeStorage.decryptString(Buffer.from(saved.password, 'base64')) } }
  catch { throw new Error('Cannot decrypt OBS password; import it again from local OBS') }
}

export function saveObsPreferences(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences> {
  return serial(brandId, () => saveConnection(brandId, input))
}

async function saveConnection(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences> {
  if (!input || typeof input.endpoint !== 'string' || Object.keys(input).some((key) => !['endpoint', 'importLocalPassword', 'clearPassword'].includes(key)) ||
      (input.importLocalPassword !== undefined && typeof input.importLocalPassword !== 'boolean') ||
      (input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') || (input.clearPassword && input.importLocalPassword)) {
    throw new Error('Invalid OBS connection preferences; passwords are never accepted over IPC')
  }
  const endpoint = normalizeEndpoint(input.endpoint)
  const previous = await read(brandId)
  const saved: Saved = { endpoint, password: previous.endpoint === endpoint && !input.clearPassword ? previous.password : undefined, recording: previous.recording }
  if (input.importLocalPassword) {
    requireEncryption()
    const root = process.platform === 'darwin' ? join(app.getPath('home'), 'Library', 'Application Support') : process.platform === 'linux' ? (process.env.XDG_CONFIG_HOME || join(app.getPath('home'), '.config')) : app.getPath('appData')
    try {
      const config = JSON.parse(await fs.readFile(join(root, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')) as Record<string, unknown>
      if (config.server_enabled !== true || config.auth_required !== true || typeof config.server_password !== 'string' || !config.server_password) throw new Error()
      if (Number(new URL(endpoint).port || 80) !== config.server_port) throw new Error()
      saved.password = safeStorage.encryptString(config.server_password).toString('base64')
    } catch { throw new Error('Cannot import local OBS password. Enable authentication in local OBS, match its port, and try again. Portable OBS is not auto-discovered') }
  }
  await write(brandId, saved)
  return { endpoint, hasPassword: !!saved.password, recording: saved.recording }
}
