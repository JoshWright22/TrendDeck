import { app, BrowserWindow, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN, isHttpUrl } from '@shared/types'
import { LOGIN_RESULTS, type LoginAttempt, type LoginInput, type LoginResult } from '@shared/vault'

// one file of saved logins. everything secret is a safeStorage blob, so the file is useless
// without this user's os keychain. the username is encrypted too, it's only shown in settings
interface Entry {
  brandId: string
  siteId: string
  // base64 of safeStorage.encryptString(json of the secret part)
  blob: string
  hasNotes: boolean
  loginUrl: string
  savedAt: number
}

interface Secret {
  username: string
  password: string
  notes: string
}

interface VaultFile {
  entries: Entry[]
  attempts: LoginAttempt[]
}

const MAX_ATTEMPTS = 300

let cache: VaultFile | null = null
let queue: Promise<void> = Promise.resolve()

function dir(): string {
  return join(app.getPath('userData'), 'vault')
}

function file(): string {
  return join(dir(), 'logins.json')
}

// why saving is refused, or '' when the keychain works
export function unavailableReason(): string {
  if (!app.isReady()) return 'the app is still starting'
  if (!safeStorage.isEncryptionAvailable()) {
    return "your system keychain isn't available, so TrendDeck won't save passwords"
  }
  // on linux with no keyring, chromium falls back to a fixed key, that's not real encryption
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') {
      return 'no system keyring found (like GNOME Keyring or KWallet), so TrendDeck won\'t save passwords'
    }
  }
  return ''
}

function clean(raw: unknown): VaultFile {
  const d = (raw ?? {}) as Partial<VaultFile>
  const entries = (Array.isArray(d.entries) ? d.entries : []).filter(
    (e): e is Entry =>
      !!e &&
      typeof e.brandId === 'string' &&
      ID_PATTERN.test(e.brandId) &&
      typeof e.siteId === 'string' &&
      ID_PATTERN.test(e.siteId) &&
      typeof e.blob === 'string'
  )
  const attempts = (Array.isArray(d.attempts) ? d.attempts : []).filter(
    (a): a is LoginAttempt => !!a && typeof a.brandId === 'string' && LOGIN_RESULTS.includes(a.result)
  )
  return {
    entries: entries.map((e) => ({
      brandId: e.brandId,
      siteId: e.siteId,
      blob: e.blob,
      hasNotes: e.hasNotes === true,
      loginUrl: typeof e.loginUrl === 'string' && isHttpUrl(e.loginUrl) ? e.loginUrl : '',
      savedAt: Number(e.savedAt) || 0
    })),
    attempts: attempts.slice(-MAX_ATTEMPTS)
  }
}

async function load(): Promise<VaultFile> {
  if (cache) return cache
  try {
    cache = clean(JSON.parse(await fs.readFile(file(), 'utf8')))
  } catch {
    cache = { entries: [], attempts: [] }
  }
  return cache
}

export function notifyVault(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('vault:changed')
}

async function change(fn: (v: VaultFile) => void): Promise<void> {
  const v = await load()
  fn(v)
  v.attempts = v.attempts.slice(-MAX_ATTEMPTS)
  const text = JSON.stringify(v, null, 2)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${file()}.tmp`
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, file())
  }
  queue = queue.then(run, run)
  await queue
  notifyVault()
}

function decrypt(blob: string): Secret | null {
  try {
    const s = JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) as Secret
    if (typeof s.username !== 'string' || typeof s.password !== 'string') return null
    return { username: s.username, password: s.password, notes: typeof s.notes === 'string' ? s.notes : '' }
  } catch {
    return null
  }
}

// what settings may see: the username and that notes exist, never the password or the notes
export async function listLogins(): Promise<
  { brandId: string; siteId: string; username: string; hasNotes: boolean; loginUrl: string; savedAt: number }[]
> {
  const v = await load()
  const canRead = unavailableReason() === ''
  return v.entries.map((e) => ({
    brandId: e.brandId,
    siteId: e.siteId,
    username: canRead ? (decrypt(e.blob)?.username ?? '(can\'t unlock, save it again)') : '(locked)',
    hasNotes: e.hasNotes,
    loginUrl: e.loginUrl,
    savedAt: e.savedAt
  }))
}

export async function hasLogin(brandId: string, siteId: string): Promise<boolean> {
  const v = await load()
  return v.entries.some((e) => e.brandId === brandId && e.siteId === siteId)
}

export async function loginUrlFor(brandId: string, siteId: string): Promise<string> {
  const v = await load()
  return v.entries.find((e) => e.brandId === brandId && e.siteId === siteId)?.loginUrl ?? ''
}

// only the login filler calls this. it never leaves the main process
export async function readSecret(brandId: string, siteId: string): Promise<Secret | null> {
  if (unavailableReason()) return null
  const v = await load()
  const e = v.entries.find((x) => x.brandId === brandId && x.siteId === siteId)
  return e ? decrypt(e.blob) : null
}

// '' when saved, otherwise why not
export async function saveLogin(brandId: string, siteId: string, input: LoginInput): Promise<string> {
  const why = unavailableReason()
  if (why) return why
  const username = input.username.trim().slice(0, 320)
  const password = input.password.slice(0, 1000)
  const notes = input.notes.slice(0, 2000)
  const loginUrl = input.loginUrl.trim().slice(0, 2000)
  if (!username) return 'add a username or email'
  if (!password) return 'add the password'
  if (loginUrl && !isHttpUrl(loginUrl)) return 'the sign-in page has to be an http or https link'
  const blob = safeStorage.encryptString(JSON.stringify({ username, password, notes })).toString('base64')
  await change((v) => {
    v.entries = v.entries.filter((e) => !(e.brandId === brandId && e.siteId === siteId))
    v.entries.push({ brandId, siteId, blob, hasNotes: notes.trim() !== '', loginUrl, savedAt: Date.now() })
  })
  return ''
}

export async function removeLogin(brandId: string, siteId: string): Promise<void> {
  await change((v) => {
    v.entries = v.entries.filter((e) => !(e.brandId === brandId && e.siteId === siteId))
  })
}

export async function forgetBrandLogins(brandId: string): Promise<void> {
  await change((v) => {
    v.entries = v.entries.filter((e) => e.brandId !== brandId)
    v.attempts = v.attempts.filter((a) => a.brandId !== brandId)
  })
}

// site, time and result. never the username, password or code
export async function logAttempt(brandId: string, siteId: string, result: LoginResult): Promise<void> {
  await change((v) => {
    v.attempts.push({ id: randomUUID(), at: Date.now(), brandId, siteId, result })
  })
}

export async function listAttempts(): Promise<LoginAttempt[]> {
  return (await load()).attempts
}
