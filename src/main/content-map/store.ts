import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { MAP_PLATFORMS, SNAPSHOT_LABELS, type MapVideo, type Pillar, type RetentionPoint, type SnapshotLabel, type VideoSnapshot } from '@shared/content-map'
import { ID_PATTERN } from '@shared/types'
import type { Client, Tokens } from './oauth'
import { NO_BACKOFF, type Backoff, type Quota, type Tracked } from './schedule'

// content-map/<brand>.json holds the catalog, pillars and the snapshot series.
// content-map/<brand>.auth holds the creator's Google tokens and content-map/client.json the
// OAuth client, both sealed with safeStorage. neither ever goes to the window or an agent

export interface MapFile {
  publicChannel: string
  channelId: string
  channelTitle: string
  videos: MapVideo[]
  pillars: Pillar[]
  tracked: Tracked[]
  quota: Quota | null
  backoff: Backoff
  lastSync: number | null
  lastSyncOk: boolean
  lastSyncNote: string
  csvImportedAt: number | null
  // "<video>:<label>" post-mortem cards already made
  postMortems: string[]
}

const MAX_VIDEOS = 500
const MAX_TRACKED = 60

export const dir = (): string => join(app.getPath('userData'), 'content-map')
const check = (brandId: string): string => {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
  return brandId
}

export function emptyMap(): MapFile {
  return { publicChannel: '', channelId: '', channelTitle: '', videos: [], pillars: [], tracked: [], quota: null, backoff: NO_BACKOFF, lastSync: null, lastSyncOk: false, lastSyncNote: '', csvImportedAt: null, postMortems: [] }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function cleanPoint(raw: unknown): RetentionPoint | null {
  const p = raw as Partial<RetentionPoint> | null
  const ratio = num(p?.ratio)
  const watch = num(p?.watch)
  return ratio === null || watch === null ? null : { ratio, watch }
}

export function cleanVideo(raw: unknown): MapVideo | null {
  const v = raw as Partial<MapVideo> | null
  if (!v || typeof v.id !== 'string' || !v.id || v.id.length > 80) return null
  if (!(MAP_PLATFORMS as readonly unknown[]).includes(v.platform)) return null
  const m = v.metrics
  const url = str(v.url, 500)
  return {
    id: v.id,
    platform: v.platform as MapVideo['platform'],
    title: str(v.title, 300),
    url: /^https:\/\//.test(url) ? url : '',
    publishedAt: num(v.publishedAt),
    duration: num(v.duration),
    format: v.format === 'short' ? 'short' : 'long',
    thumbnailText: str(v.thumbnailText, 200),
    tags: arr(v.tags).filter((t): t is string => typeof t === 'string').slice(0, 30),
    description: str(v.description, 1500),
    hook: str(v.hook, 1200),
    hookSource: (['captions', 'take', 'transcript', 'script'] as const).find((x) => x === v.hookSource) ?? '',
    pacing: v.pacing && typeof v.pacing.wpm === 'number' ? { ...v.pacing } : null,
    metrics: m && typeof m === 'object'
      ? {
          views: num(m.views),
          engagedViews: num(m.engagedViews),
          avgViewDuration: num(m.avgViewDuration),
          avgViewPercent: num(m.avgViewPercent),
          likes: num(m.likes),
          comments: num(m.comments),
          shares: num(m.shares),
          subsGained: num(m.subsGained),
          impressions: num(m.impressions),
          ctr: num(m.ctr),
          at: num(m.at) ?? 0,
          sources: arr(m.sources).filter((x): x is NonNullable<MapVideo['metrics']>['sources'][number] => typeof x === 'string').slice(0, 5)
        }
      : null,
    retention: arr(v.retention).map(cleanPoint).filter((p): p is RetentionPoint => p !== null).slice(0, 120),
    retentionAt: num(v.retentionAt),
    projectId: typeof v.projectId === 'string' && ID_PATTERN.test(v.projectId) ? v.projectId : null,
    projectPinned: v.projectPinned === true
  }
}

function cleanSnapshot(raw: unknown): VideoSnapshot | null {
  const s = raw as Partial<VideoSnapshot> | null
  if (!s || !(SNAPSHOT_LABELS as readonly unknown[]).includes(s.label)) return null
  const at = num(s.at)
  if (at === null) return null
  return {
    label: s.label as SnapshotLabel,
    due: num(s.due) ?? at,
    at,
    views: num(s.views),
    engagedViews: num(s.engagedViews),
    likes: num(s.likes),
    comments: num(s.comments),
    avgViewPercent: num(s.avgViewPercent),
    source: (['analytics', 'data-api', 'rss', 'page', 'csv'] as const).find((x) => x === s.source) ?? 'data-api'
  }
}

function cleanTracked(raw: unknown): Tracked | null {
  const t = raw as Partial<Tracked> | null
  if (!t || typeof t.id !== 'string' || num(t.publishedAt) === null) return null
  return {
    id: t.id.slice(0, 80),
    publishedAt: t.publishedAt as number,
    taken: arr(t.taken).map(cleanSnapshot).filter((s): s is VideoSnapshot => s !== null),
    missed: arr(t.missed).filter((l): l is SnapshotLabel => (SNAPSHOT_LABELS as readonly unknown[]).includes(l))
  }
}

function cleanPillar(raw: unknown): Pillar | null {
  const p = raw as Partial<Pillar> | null
  if (!p || typeof p.id !== 'string' || typeof p.label !== 'string' || !p.label.trim()) return null
  return {
    id: p.id.slice(0, 40),
    label: p.label.trim().slice(0, 60),
    keywords: arr(p.keywords).filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim().slice(0, 40)).slice(0, 20),
    why: str(p.why, 300),
    createdAt: num(p.createdAt) ?? 0
  }
}

export function cleanMap(raw: unknown): MapFile {
  const d = (raw ?? {}) as Partial<MapFile>
  const b = d.backoff as Partial<Backoff> | undefined
  const q = d.quota as Partial<Quota> | undefined
  return {
    publicChannel: str(d.publicChannel, 120),
    channelId: str(d.channelId, 40),
    channelTitle: str(d.channelTitle, 200),
    videos: arr(d.videos).map(cleanVideo).filter((v): v is MapVideo => v !== null).slice(0, MAX_VIDEOS),
    pillars: arr(d.pillars).map(cleanPillar).filter((p): p is Pillar => p !== null).slice(0, 12),
    tracked: arr(d.tracked).map(cleanTracked).filter((t): t is Tracked => t !== null).slice(-MAX_TRACKED),
    quota: q && typeof q.day === 'string' && typeof q.used === 'number' ? { day: q.day, used: q.used } : null,
    backoff: b ? { until: num(b.until), failures: num(b.failures) ?? 0, reason: str(b.reason, 300) } : NO_BACKOFF,
    lastSync: num(d.lastSync),
    lastSyncOk: d.lastSyncOk === true,
    lastSyncNote: str(d.lastSyncNote, 400),
    csvImportedAt: num(d.csvImportedAt),
    postMortems: arr(d.postMortems).filter((x): x is string => typeof x === 'string').slice(-400)
  }
}

const cache = new Map<string, MapFile>()
const queues = new Map<string, Promise<unknown>>()

function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
  queues.set(key, next.catch(() => {}))
  return next
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(`${path}.tmp`, text, 'utf8')
  await fs.rename(`${path}.tmp`, path)
}

export async function loadMap(brandId: string): Promise<MapFile> {
  const hit = cache.get(check(brandId))
  if (hit) return structuredClone(hit)
  let m = emptyMap()
  try {
    m = cleanMap(JSON.parse(await fs.readFile(join(dir(), `${brandId}.json`), 'utf8')))
  } catch {
    // nothing yet
  }
  cache.set(brandId, m)
  return structuredClone(m)
}

// one change at a time per brand, fn changes the copy in place
export function changeMap<T>(brandId: string, fn: (m: MapFile) => T | Promise<T>): Promise<T> {
  return serial(check(brandId), async () => {
    const m = await loadMap(brandId)
    const out = await fn(m)
    const clean = cleanMap(m)
    cache.set(brandId, clean)
    await writeAtomic(join(dir(), `${brandId}.json`), JSON.stringify(clean))
    return out
  })
}

export async function dropMap(brandId: string): Promise<void> {
  check(brandId)
  await serial(brandId, async () => {
    cache.delete(brandId)
    opened.delete(brandId)
    await fs.rm(join(dir(), `${brandId}.json`), { force: true })
    await fs.rm(join(dir(), `${brandId}.auth`), { force: true })
  })
}

// ---------- sealed secrets ----------

function seal(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  // without OS encryption the tokens aren't kept at all, see saveTokens
  return ''
}

function unseal(stored: string): string {
  if (!stored.startsWith('enc:')) return ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  } catch {
    return ''
  }
}

export interface Auth {
  tokens: Tokens
  channelId: string
  channelTitle: string
}

// decrypted once, for the API calls and for redaction
const opened = new Map<string, Auth | null>()
let client: Client | null | undefined

export async function loadAuth(brandId: string): Promise<Auth | null> {
  if (opened.has(check(brandId))) return opened.get(brandId) ?? null
  let a: Auth | null = null
  try {
    const raw = JSON.parse(unseal(await fs.readFile(join(dir(), `${brandId}.auth`), 'utf8'))) as Partial<Auth>
    const t = raw.tokens as Partial<Tokens> | undefined
    if (t && typeof t.access === 'string' && typeof t.refresh === 'string' && t.refresh) {
      a = { tokens: { access: t.access, refresh: t.refresh, expiresAt: Number(t.expiresAt) || 0, scope: str(t.scope, 500) }, channelId: str(raw.channelId, 40), channelTitle: str(raw.channelTitle, 200) }
    }
  } catch {
    // not connected
  }
  opened.set(brandId, a)
  return a
}

export function saveAuth(brandId: string, a: Auth | null): Promise<void> {
  return serial(`auth:${check(brandId)}`, async () => {
    const path = join(dir(), `${brandId}.auth`)
    if (!a) {
      opened.set(brandId, null)
      await fs.rm(path, { force: true })
      return
    }
    const sealed = seal(JSON.stringify(a))
    if (!sealed) throw new Error("Windows can't encrypt the sign-in on this account, so TrendDeck won't keep it.")
    opened.set(brandId, a)
    await writeAtomic(path, sealed)
  })
}

export async function loadClient(): Promise<Client | null> {
  if (client !== undefined) return client
  try {
    const raw = JSON.parse(await fs.readFile(join(dir(), 'client.json'), 'utf8')) as { id?: unknown; secret?: unknown }
    client = typeof raw.id === 'string' && raw.id ? { id: raw.id, secret: typeof raw.secret === 'string' ? unseal(raw.secret) : '' } : null
  } catch {
    client = null
  }
  return client
}

export async function saveClient(next: Client | null): Promise<void> {
  const path = join(dir(), 'client.json')
  if (!next) {
    client = null
    await fs.rm(path, { force: true })
    return
  }
  const secret = next.secret ? seal(next.secret) : ''
  if (next.secret && !secret) throw new Error("Windows can't encrypt the client secret on this account, so TrendDeck won't keep it.")
  client = next
  await writeAtomic(path, JSON.stringify({ id: next.id, secret }))
}

// every token and the client secret main holds right now, for the redaction pass
export function openSecrets(): string[] {
  const out: string[] = []
  for (const a of opened.values()) if (a) out.push(a.tokens.access, a.tokens.refresh)
  if (client?.secret) out.push(client.secret)
  return out.filter((s) => s.length >= 8)
}
