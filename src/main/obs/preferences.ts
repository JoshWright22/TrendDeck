import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ObsConnectionInput, ObsPreferences } from '@shared/obs'
import { ID_PATTERN } from '@shared/types'
import { getData } from '../store'
import { normalizeEndpoint } from './protocol'

interface Saved { endpoint: string; password?: string }

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
    return { endpoint: normalizeEndpoint(saved.endpoint), password: typeof saved.password === 'string' ? saved.password : undefined }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { endpoint: 'ws://127.0.0.1:4455/' }
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
  return { endpoint: saved.endpoint, hasPassword: !!saved.password }
}

export async function obsCredentials(brandId: string): Promise<{ endpoint: string; password?: string }> {
  const saved = await read(brandId)
  if (!saved.password) return { endpoint: saved.endpoint }
  requireEncryption()
  try { return { endpoint: saved.endpoint, password: safeStorage.decryptString(Buffer.from(saved.password, 'base64')) } }
  catch { throw new Error('Cannot decrypt OBS password; import it again from local OBS') }
}

export async function saveObsPreferences(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences> {
  if (!input || typeof input.endpoint !== 'string' || Object.keys(input).some((key) => !['endpoint', 'importLocalPassword', 'clearPassword'].includes(key)) ||
      (input.importLocalPassword !== undefined && typeof input.importLocalPassword !== 'boolean') ||
      (input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') || (input.clearPassword && input.importLocalPassword)) {
    throw new Error('Invalid OBS connection preferences; passwords are never accepted over IPC')
  }
  const endpoint = normalizeEndpoint(input.endpoint)
  const previous = await read(brandId)
  const saved: Saved = { endpoint, password: previous.endpoint === endpoint && !input.clearPassword ? previous.password : undefined }
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
  const target = file(brandId)
  await fs.mkdir(join(app.getPath('userData'), 'obs'), { recursive: true })
  await fs.writeFile(`${target}.tmp`, JSON.stringify(saved), { mode: 0o600 })
  await fs.rename(`${target}.tmp`, target)
  return { endpoint, hasPassword: !!saved.password }
}
