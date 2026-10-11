import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import {
  API_FIELDS,
  PLATFORMS,
  type BrandPosting,
  type LogEntry,
  type Platform,
  type PostItem,
  type PostingState,
  type PostMode,
  type PostStatus
} from '@shared/posting'

const STATE_FILE = 'posting.json'
// api secrets live in their own file, encrypted when the os allows it
const KEYS_FILE = 'posting-keys.json'
const LOG_MAX = 1000

const STATUSES: PostStatus[] = [
  'draft',
  'scheduled',
  'queued',
  'running',
  'review',
  'posted',
  'failed',
  'closed',
  'missed'
]

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const isPlatform = (v: unknown): v is Platform => (PLATFORMS as readonly unknown[]).includes(v)

export function cleanPost(raw: unknown): PostItem | null {
  const p = raw as Partial<PostItem> | null
  if (!p || typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) return null
  if (typeof p.brandId !== 'string' || !ID_PATTERN.test(p.brandId)) return null
  if (!isPlatform(p.platform)) return null
  const status = STATUSES.includes(p.status as PostStatus) ? (p.status as PostStatus) : 'draft'
  const mediaUrl = str(p.mediaUrl, 2000)
  return {
    id: p.id,
    brandId: p.brandId,
    platform: p.platform,
    title: str(p.title, 300),
    body: str(p.body, 40000),
    mediaId: ID_PATTERN.test(str(p.mediaId, 100)) ? str(p.mediaId, 100) : '',
    byAgent: p.byAgent === true,
    mediaUrl: /^https:\/\//i.test(mediaUrl) ? mediaUrl : '',
    subreddit: str(p.subreddit, 21).replace(/^r\//i, '').replace(/[^A-Za-z0-9_]/g, ''),
    visibility: p.visibility === 'unlisted' || p.visibility === 'private' ? p.visibility : 'public',
    scheduledAt: typeof p.scheduledAt === 'number' && p.scheduledAt > 0 ? p.scheduledAt : null,
    status,
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
    note: str(p.note, 1000),
    url: /^https:\/\//i.test(str(p.url, 1000)) ? str(p.url, 1000) : ''
  }
}

function cleanLog(raw: unknown): LogEntry | null {
  const l = raw as Partial<LogEntry> | null
  if (!l || typeof l.id !== 'string' || !isPlatform(l.platform)) return null
  if (typeof l.brandId !== 'string') return null
  const results = ['posted', 'failed', 'review', 'closed', 'missed', 'check']
  return {
    id: l.id,
    at: Number(l.at) || 0,
    postId: typeof l.postId === 'string' ? l.postId : null,
    brandId: l.brandId,
    platform: l.platform,
    mode: l.mode === 'api' ? 'api' : 'tabs',
    result: results.includes(l.result as string) ? (l.result as LogEntry['result']) : 'failed',
    message: str(l.message, 2000)
  }
}

export function defaultBrand(): BrandPosting {
  const modes = {} as Record<Platform, PostMode>
  const keys = {} as Record<Platform, string[]>
  for (const p of PLATFORMS) {
    modes[p] = 'tabs'
    keys[p] = []
  }
  return { autoPost: false, modes, keys }
}

function cleanBrand(raw: unknown): BrandPosting {
  const b = raw as Partial<BrandPosting> | null
  const out = defaultBrand()
  if (!b) return out
  out.autoPost = b.autoPost === true
  for (const p of PLATFORMS) {
    if (b.modes?.[p] === 'api') out.modes[p] = 'api'
  }
  return out
}

let state: PostingState = { posts: [], log: [], brands: {} }
let secrets: Record<string, Record<string, string>> = {}
let loaded = false

const statePath = (): string => join(app.getPath('userData'), STATE_FILE)
const keysPath = (): string => join(app.getPath('userData'), KEYS_FILE)
const secretId = (brandId: string, platform: Platform): string => `${brandId}:${platform}`

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function loadPosting(): Promise<void> {
  if (loaded) return
  loaded = true
  const raw = (await readJson(statePath())) as Partial<PostingState> | null
  if (raw) {
    state.posts = Array.isArray(raw.posts)
      ? raw.posts.map(cleanPost).filter((p): p is PostItem => p !== null)
      : []
    state.log = Array.isArray(raw.log)
      ? raw.log.map(cleanLog).filter((l): l is LogEntry => l !== null)
      : []
    state.brands = {}
    if (raw.brands && typeof raw.brands === 'object') {
      for (const [id, b] of Object.entries(raw.brands)) {
        if (ID_PATTERN.test(id)) state.brands[id] = cleanBrand(b)
      }
    }
  }
  const k = (await readJson(keysPath())) as { enc?: boolean; data?: string } | null
  if (k && typeof k.data === 'string') {
    try {
      const text =
        k.enc && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(k.data, 'base64'))
          : k.enc
            ? '{}'
            : k.data
      const parsed = JSON.parse(text) as Record<string, Record<string, string>>
      if (parsed && typeof parsed === 'object') secrets = parsed
    } catch {
      secrets = {}
    }
  }
}

let writing: Promise<void> = Promise.resolve()

async function writeFile(file: string, text: string): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(`${file}.tmp`, text, 'utf8')
  await fs.rename(`${file}.tmp`, file)
}

function persist(): Promise<void> {
  const text = JSON.stringify(state, null, 2)
  const run = (): Promise<void> => writeFile(statePath(), text)
  writing = writing.then(run, run)
  return writing
}

function persistKeys(): Promise<void> {
  const json = JSON.stringify(secrets)
  const enc = safeStorage.isEncryptionAvailable()
  const data = enc ? safeStorage.encryptString(json).toString('base64') : json
  const run = (): Promise<void> => writeFile(keysPath(), JSON.stringify({ enc, data }))
  writing = writing.then(run, run)
  return writing
}

// the renderer gets this, with saved key names filled in but never their values
export function getState(): PostingState {
  const brands: Record<string, BrandPosting> = {}
  for (const [id, b] of Object.entries(state.brands)) {
    const keys = {} as Record<Platform, string[]>
    for (const p of PLATFORMS) keys[p] = Object.keys(secrets[secretId(id, p)] ?? {})
    brands[id] = { ...b, keys }
  }
  return { posts: state.posts, log: state.log, brands }
}

let listener: (() => void) | null = null

export function onChange(fn: () => void): void {
  listener = fn
}

function changed(): Promise<void> {
  listener?.()
  return persist()
}

export function getPost(id: string): PostItem | undefined {
  return state.posts.find((p) => p.id === id)
}

export function allPosts(): PostItem[] {
  return state.posts
}

export function putPosts(posts: PostItem[]): Promise<void> {
  for (const post of posts) {
    const i = state.posts.findIndex((p) => p.id === post.id)
    if (i >= 0) state.posts[i] = post
    else state.posts.unshift(post)
  }
  return changed()
}

export function patchPost(id: string, patch: Partial<PostItem>): Promise<void> {
  const i = state.posts.findIndex((p) => p.id === id)
  if (i < 0) return Promise.resolve()
  state.posts[i] = { ...state.posts[i], ...patch, updatedAt: Date.now() }
  return changed()
}

export function removePost(id: string): Promise<void> {
  state.posts = state.posts.filter((p) => p.id !== id)
  return changed()
}

export function addLog(entry: LogEntry): Promise<void> {
  state.log.unshift(entry)
  if (state.log.length > LOG_MAX) state.log.length = LOG_MAX
  return changed()
}

export function clearLog(brandId: string): Promise<void> {
  state.log = state.log.filter((l) => l.brandId !== brandId)
  return changed()
}

export function brandSettings(brandId: string): BrandPosting {
  return state.brands[brandId] ?? defaultBrand()
}

export function patchBrand(
  brandId: string,
  patch: Partial<Pick<BrandPosting, 'autoPost' | 'modes'>>
): Promise<void> {
  const cur = brandSettings(brandId)
  state.brands[brandId] = cleanBrand({ ...cur, ...patch, modes: { ...cur.modes, ...patch.modes } })
  return changed()
}

// drops everything a deleted brand left behind
export async function dropBrand(brandId: string): Promise<void> {
  delete state.brands[brandId]
  state.posts = state.posts.filter((p) => p.brandId !== brandId)
  state.log = state.log.filter((l) => l.brandId !== brandId)
  for (const p of PLATFORMS) delete secrets[secretId(brandId, p)]
  await persistKeys()
  await changed()
}

export function getKeys(brandId: string, platform: Platform): Record<string, string> {
  return { ...(secrets[secretId(brandId, platform)] ?? {}) }
}

export function setKeys(
  brandId: string,
  platform: Platform,
  values: Record<string, string> | null
): Promise<void> {
  const id = secretId(brandId, platform)
  if (values === null) {
    delete secrets[id]
  } else {
    const allowed = new Set([
      ...API_FIELDS[platform].map((f) => f.key),
      // set by the youtube sign in, not typed by hand
      'refreshToken'
    ])
    const next = { ...(secrets[id] ?? {}) }
    for (const [k, v] of Object.entries(values)) {
      if (!allowed.has(k) || typeof v !== 'string') continue
      const val = v.trim().slice(0, 4000)
      if (val) next[k] = val
    }
    secrets[id] = next
  }
  listener?.()
  return persistKeys()
}
