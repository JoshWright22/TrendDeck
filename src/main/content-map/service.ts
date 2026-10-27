import { net, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  clock,
  ratioText,
  SNAPSHOT_NAMES,
  type ChannelState,
  type ContentMapView,
  type MapVideo,
  type MetricSource,
  type Pillar,
  type SnapshotLabel,
  type VideoDetail
} from '@shared/content-map'
import type { Learning, PostMortemCard, TakeCard } from '@shared/cards'
import { videoProjects } from '@shared/workspace'
import { threadsFor } from '../agents/history'
import { readJson } from '../analytics/files'
import { cleanAnalyticsDoc } from '../analytics/stats'
import { addLearning } from '../brand-memory'
import { addCard, allCards, changeCard, getCard, newCardId } from '../cards/store'
import { knownFolder } from '../craft/paths'
import { broadcast } from '../gateway/wait'
import { getData } from '../store'
import { baselines, groupStat, matchProject, median, rows, topKeywords, whatWorked } from './baseline'
import { refresh, signIn, type Client } from './oauth'
import { readLocal, type LocalInfo } from './projects'
import { findDips, hookFromLines, hookFromWords, pacingFromLines, pacingFromWords, summarizeRetention, type Dip } from './retention'
import { ageRatio, finished, nextQuotaReset, QUOTA_LIMIT, quotaUsed, spend, tick, type Reading } from './schedule'
import { changeMap, loadAuth, loadClient, loadMap, saveAuth, saveClient, type MapFile } from './store'
import {
  channelIdFromHtml,
  cleanChannel,
  fetchChannel,
  fetchContentTypes,
  fetchRetention,
  fetchUploads,
  fetchVideoList,
  fetchVideoMetrics,
  formatOf,
  parseRss,
  parseStudioCsv,
  rssUrl,
  type Auth,
  type Counter,
  type FetchJson
} from './youtube'

// builds and keeps the content map: syncs the catalog from YouTube, the logged-in readers and
// the project folders, takes the post-publish snapshots and makes the post-mortem cards

const TIMEOUT_MS = 20_000
// retention calls per sync, the rest come on the next one
const RETENTION_PER_SYNC = 25
const DAY = 24 * 3600_000

export const changed = (brandId: string): void => broadcast('content-map:changed', brandId)
const isChannelId = (id: string): boolean => /^UC[\w-]{22}$/.test(id)

// ---------- network, main only ----------

async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await net.fetch(url, { ...init, signal: ctrl.signal })
    return { ok: res.ok, status: res.status, text: await res.text() }
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${new URL(url).hostname} timed out`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Google's errors name the reason, e.g. quotaExceeded. the url never goes in the message
export const fetchJson: FetchJson = async (url, init) => {
  const r = await request(url, { headers: init?.headers })
  if (!r.ok) {
    let why = ''
    try {
      const e = (JSON.parse(r.text) as { error?: { message?: string; errors?: { reason?: string }[] } }).error
      why = [e?.errors?.[0]?.reason, e?.message].filter(Boolean).join(': ')
    } catch {
      why = r.text.slice(0, 120)
    }
    throw new Error(`${new URL(url).hostname} said ${r.status}${why ? ` ${why}` : ''}`.slice(0, 300))
  }
  return JSON.parse(r.text) as unknown
}

const fetchText = async (url: string): Promise<string> => {
  const r = await request(url, { headers: { 'accept-language': 'en-US,en;q=0.9' } })
  if (!r.ok) throw new Error(`${new URL(url).hostname} said ${r.status}`)
  return r.text
}

const postForm = async (url: string, form: Record<string, string>): Promise<unknown> => {
  const r = await request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
  try {
    return JSON.parse(r.text) as unknown
  } catch {
    return { error: `token endpoint said ${r.status}` }
  }
}

// ---------- auth ----------

const connecting = new Set<string>()
const syncing = new Map<string, Promise<ChannelState>>()

async function accessToken(brandId: string): Promise<string> {
  const a = await loadAuth(brandId)
  if (!a) throw new Error('YouTube is not connected')
  if (a.tokens.expiresAt > Date.now() + 60_000) return a.tokens.access
  const client = await loadClient()
  if (!client) throw new Error('The Google OAuth client is gone, sign-in expired. Add it again in Settings, Channels.')
  try {
    const tokens = await refresh(client, a.tokens, postForm, Date.now())
    await saveAuth(brandId, { ...a, tokens })
    return tokens.access
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(/invalid_grant|expired|revoked/i.test(msg) ? 'Your YouTube sign-in expired. Connect again in Settings, Channels.' : msg)
  }
}

export async function channelState(brandId: string): Promise<ChannelState> {
  const m = await loadMap(brandId)
  const auth = await loadAuth(brandId)
  const client = await loadClient()
  const hasKey = !!getData()?.settings.youtubeApiKey
  const now = Date.now()
  return {
    mode: auth ? 'oauth' : m.publicChannel ? (hasKey ? 'api-key' : 'rss') : 'none',
    channelId: auth?.channelId || m.channelId,
    channelTitle: auth?.channelTitle || m.channelTitle,
    publicChannel: m.publicChannel,
    hasClient: !!client,
    clientId: client?.id ?? '',
    hasApiKey: hasKey,
    connecting: connecting.has(brandId),
    syncing: syncing.has(brandId),
    lastSync: m.lastSync,
    lastSyncOk: m.lastSyncOk,
    lastSyncNote: m.lastSyncNote,
    quotaUsedToday: quotaUsed(m.quota, now),
    quotaLimit: QUOTA_LIMIT,
    backoffUntil: m.backoff.until && m.backoff.until > now ? m.backoff.until : null,
    videos: m.videos.length,
    csvImportedAt: m.csvImportedAt
  }
}

export async function setClient(id: string, secret: string): Promise<void> {
  const cleanId = id.trim()
  if (!/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/.test(cleanId)) throw new Error('That doesn\'t look like a Google OAuth client ID. It ends in .apps.googleusercontent.com.')
  const prev = await loadClient()
  await saveClient({ id: cleanId, secret: secret.trim() || (prev?.id === cleanId ? prev.secret : '') })
}

export async function clearClient(): Promise<void> {
  await saveClient(null)
}

export async function connect(brandId: string): Promise<ChannelState> {
  const client = await loadClient()
  if (!client) throw new Error('Add your Google OAuth client ID first.')
  if (connecting.has(brandId)) throw new Error('A sign-in is already open in your browser.')
  connecting.add(brandId)
  changed(brandId)
  try {
    const tokens = await signIn(client as Client, { open: (url) => shell.openExternal(url), post: postForm, now: Date.now })
    const counter: Counter = { units: 0, analyticsCalls: 0 }
    const ch = await fetchChannel(fetchJson, { kind: 'oauth', token: tokens.access }, '', counter)
    await saveAuth(brandId, { tokens, channelId: ch.id, channelTitle: ch.title })
    await changeMap(brandId, (m) => {
      m.channelId = ch.id
      m.channelTitle = ch.title
      m.backoff = { until: null, failures: 0, reason: '' }
      m.quota = spend(m.quota, Date.now(), counter.units, Infinity)
    })
  } finally {
    connecting.delete(brandId)
    changed(brandId)
  }
  void sync(brandId).catch(() => {})
  return channelState(brandId)
}

export async function disconnect(brandId: string): Promise<ChannelState> {
  const a = await loadAuth(brandId)
  await saveAuth(brandId, null)
  // tell Google too, a failure here still leaves TrendDeck without the tokens
  if (a) await request(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.tokens.refresh)}`, { method: 'POST' }).catch(() => null)
  changed(brandId)
  return channelState(brandId)
}

export async function setPublicChannel(brandId: string, input: string): Promise<ChannelState> {
  const ch = input.trim() ? cleanChannel(input) : ''
  if (input.trim() && !ch) throw new Error('Use the channel handle like @name, or its id starting with UC.')
  await changeMap(brandId, (m) => {
    if (m.publicChannel !== ch) {
      m.publicChannel = ch
      m.channelId = ch.startsWith('UC') ? ch : ''
      m.channelTitle = ''
    }
  })
  changed(brandId)
  if (ch) void sync(brandId).catch(() => {})
  return channelState(brandId)
}

// ---------- sync ----------

type Fresh = Omit<MapVideo, 'hook' | 'hookSource' | 'pacing' | 'retention' | 'retentionAt' | 'projectId' | 'projectPinned'>

async function youtubeCatalog(brandId: string, m: MapFile, counter: Counter, now: number): Promise<{ videos: Fresh[]; retention: Map<string, MapVideo['retention']>; channelId: string; channelTitle: string; notes: string[] }> {
  const notes: string[] = []
  const retention = new Map<string, MapVideo['retention']>()
  const auth = await loadAuth(brandId)
  const key = getData()?.settings.youtubeApiKey ?? ''
  if (auth) {
    const token = await accessToken(brandId)
    const a: Auth = { kind: 'oauth', token }
    const ch = await fetchChannel(fetchJson, a, '', counter)
    const videos = await fetchUploads(fetchJson, a, ch, counter, now)
    const since = Math.min(now - DAY, ...videos.map((v) => v.publishedAt ?? now))
    try {
      const metrics = await fetchVideoMetrics(fetchJson, token, since, now, counter)
      for (const v of videos) {
        const x = metrics.get(v.id)
        if (x && v.metrics) v.metrics = { ...v.metrics, ...Object.fromEntries(Object.entries(x).filter(([, val]) => val !== null)), sources: ['data-api', 'analytics'] }
      }
    } catch (err) {
      notes.push(`Watch time and retention numbers didn't load: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const types = await fetchContentTypes(fetchJson, token, since, now, counter)
      for (const v of videos) {
        const t = types.get(v.id)
        if (t) v.format = formatOf(v.duration, { contentType: t })
      }
    } catch {
      // older channels' reports may not have it, the duration rule stays
    }
    // retention for videos without a curve and recent ones whose curve still moves
    const old = new Map(m.videos.map((v) => [v.id, v]))
    const want = videos
      .filter((v) => (v.duration ?? 0) >= 30)
      .filter((v) => {
        const p = old.get(v.id)
        if (!p?.retention.length) return true
        return (v.publishedAt ?? 0) > now - 35 * DAY && (p.retentionAt ?? 0) < now - DAY
      })
      .slice(0, RETENTION_PER_SYNC)
    for (const v of want) {
      try {
        const pts = await fetchRetention(fetchJson, token, v.id, v.publishedAt ?? since, now, counter)
        if (pts.length) retention.set(v.id, pts)
      } catch {
        // retention needs some views first, it's tried again next sync
      }
    }
    return { videos, retention, channelId: ch.id, channelTitle: ch.title, notes }
  }
  if (!m.publicChannel) return { videos: [], retention, channelId: m.channelId, channelTitle: m.channelTitle, notes }
  if (key) {
    const a: Auth = { kind: 'key', key }
    const ch = await fetchChannel(fetchJson, a, m.publicChannel, counter)
    return { videos: await fetchUploads(fetchJson, a, ch, counter, now, 200), retention, channelId: ch.id, channelTitle: ch.title, notes: ['Public numbers only: connect the channel with Google for watch time and retention.'] }
  }
  let id = m.publicChannel.startsWith('UC') ? m.publicChannel : isChannelId(m.channelId) ? m.channelId : ''
  if (!id) id = channelIdFromHtml(await fetchText(`https://www.youtube.com/${m.publicChannel}`))
  if (!id) throw new Error(`Couldn't find the channel ${m.publicChannel} on YouTube.`)
  const feed = parseRss(await fetchText(rssUrl(id)), now)
  return {
    videos: feed.videos,
    retention,
    channelId: id,
    channelTitle: feed.channelTitle,
    notes: ["From the channel's public feed: the 15 newest videos, views and likes only. Add a YouTube API key in Settings, Trends for the whole channel, or connect with Google for watch time and retention."]
  }
}

// tiktok, instagram (and youtube when there's nothing better) from the logged-in readers
async function readerVideos(brandId: string, skipYoutube: boolean): Promise<Fresh[]> {
  const doc = cleanAnalyticsDoc(await readJson('analytics', brandId))
  const out: Fresh[] = []
  for (const platform of ['youtube', 'tiktok', 'instagram'] as const) {
    if (platform === 'youtube' && skipYoutube) continue
    const snap = [...doc.snapshots].reverse().find((s) => s.platform === platform)
    if (!snap) continue
    const source: MetricSource = snap.via === 'api' ? 'data-api' : 'page'
    for (const p of snap.posts) {
      out.push({
        id: p.id,
        platform,
        title: p.title,
        url: p.url,
        publishedAt: p.publishedAt,
        duration: null,
        format: platform === 'youtube' ? formatOf(null, { shortsLink: /\/shorts\//.test(p.url), text: p.title }) : 'short',
        thumbnailText: '',
        tags: [],
        description: '',
        metrics: { views: p.views, engagedViews: null, avgViewDuration: null, avgViewPercent: null, likes: p.likes, comments: p.comments, shares: null, subsGained: null, impressions: null, ctr: null, at: snap.at, sources: [source] }
      })
    }
  }
  return out
}

async function localInfos(brandId: string): Promise<LocalInfo[]> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (!brand) return []
  const takes = (await allCards(brandId)).filter((c): c is TakeCard => c.type === 'take')
  return Promise.all(videoProjects(brand.projects).map((p) => readLocal(p, knownFolder(brandId, p.id), takes)))
}

function fillFromProject(v: MapVideo, local: LocalInfo | undefined): MapVideo {
  if (!local) return v
  const out = { ...v }
  if (local.lines.length && local.lines[0].source === 'transcript') {
    out.hook = hookFromLines(local.lines).slice(0, 1200)
    out.hookSource = 'transcript'
  } else if (local.words.length) {
    out.hook = hookFromWords(local.words).slice(0, 1200)
    out.hookSource = 'take'
  } else if (local.script.length) {
    out.hook = local.script.join(' ').split(/\s+/).slice(0, 75).join(' ')
    out.hookSource = 'script'
  }
  out.pacing = local.words.length ? pacingFromWords(local.words, 'take') : local.lines.length && local.lines[0].source === 'transcript' ? pacingFromLines(local.lines) : null
  if (local.thumbnailText) out.thumbnailText = local.thumbnailText
  return out
}

const blank = (f: Fresh): MapVideo => ({ ...f, hook: '', hookSource: '', pacing: null, retention: [], retentionAt: null, projectId: null, projectPinned: false })

async function runSync(brandId: string): Promise<ChannelState> {
  const now = Date.now()
  const m = await loadMap(brandId)
  const counter: Counter = { units: 0, analyticsCalls: 0 }
  const notes: string[] = []
  let ok = true
  let yt: Awaited<ReturnType<typeof youtubeCatalog>> | null = null
  if (quotaUsed(m.quota, now) > QUOTA_LIMIT - 50) {
    notes.push(`TrendDeck used its YouTube quota for today, it syncs again after ${new Date(nextQuotaReset(now)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`)
  } else {
    try {
      yt = await youtubeCatalog(brandId, m, counter, now)
      notes.push(...yt.notes)
    } catch (err) {
      ok = false
      notes.push(err instanceof Error ? err.message : String(err))
    }
  }
  const readers = await readerVideos(brandId, !!yt?.videos.length || m.videos.some((v) => v.platform === 'youtube' && v.metrics?.sources.some((s) => s !== 'page')))
  const locals = await localInfos(brandId)
  const projects = locals.map((l) => ({ id: l.projectId, name: l.name }))

  await changeMap(brandId, (map) => {
    const old = new Map(map.videos.map((v) => [v.id, v]))
    const next = new Map<string, MapVideo>()
    // youtube from the api or feed replaces the old copy; videos the feed no longer lists stay
    const fresh = [...(yt?.videos ?? []), ...readers.filter((r) => !(yt?.videos ?? []).some((y) => y.id === r.id))]
    for (const f of fresh) {
      const prev = old.get(f.id)
      const v = prev ? { ...prev, ...f, metrics: f.metrics } : blank(f)
      // impressions and ctr only come from a Studio export, keep them
      if (prev?.metrics && v.metrics) {
        v.metrics.impressions ??= prev.metrics.impressions
        v.metrics.ctr ??= prev.metrics.ctr
        if (prev.metrics.avgViewPercent !== null && v.metrics.avgViewPercent === null) v.metrics.avgViewPercent = prev.metrics.avgViewPercent
        if (v.duration === null) v.duration = prev.duration
        if (!v.tags.length) v.tags = prev.tags
      }
      const pts = yt?.retention.get(f.id)
      if (pts) {
        v.retention = pts
        v.retentionAt = now
      }
      next.set(f.id, v)
    }
    for (const [id, v] of old) if (!next.has(id) && v.platform !== 'local') next.set(id, v)
    // projects: the creator's pick stays, otherwise the closest name
    const linked = new Set<string>()
    for (const v of next.values()) {
      if (!v.projectPinned) v.projectId = matchProject(v.title, projects)
      if (v.projectId) linked.add(v.projectId)
    }
    // projects with a script or an export that aren't a post yet
    for (const l of locals) {
      if (linked.has(l.projectId) || (!l.script.length && l.exportAt === null)) continue
      const v = blank({ id: `local:${l.projectId}`, platform: 'local', title: l.name, url: '', publishedAt: null, duration: null, format: 'long', thumbnailText: '', tags: [], description: '', metrics: null })
      v.projectId = l.projectId
      next.set(v.id, v)
    }
    const byProject = new Map(locals.map((l) => [l.projectId, l]))
    map.videos = [...next.values()].map((v) => fillFromProject(v, v.projectId ? byProject.get(v.projectId) : undefined)).sort((a, b) => (b.publishedAt ?? now) - (a.publishedAt ?? now))
    if (yt) {
      map.channelId = yt.channelId
      map.channelTitle = yt.channelTitle
    }
    // new uploads join the snapshot schedule
    for (const v of map.videos) {
      if (v.platform !== 'youtube' || v.publishedAt === null || map.tracked.some((t) => t.id === v.id)) continue
      if (finished({ publishedAt: v.publishedAt, taken: [], missed: [] }, now)) continue
      map.tracked.push({ id: v.id, publishedAt: v.publishedAt, taken: [], missed: [] })
    }
    map.tracked.sort((a, b) => a.publishedAt - b.publishedAt)
    map.quota = spend(map.quota, now, counter.units, Infinity)
    map.lastSync = now
    map.lastSyncOk = ok
    map.lastSyncNote = notes.join(' ').slice(0, 400)
  })
  return channelState(brandId)
}

export function sync(brandId: string): Promise<ChannelState> {
  const busy = syncing.get(brandId)
  if (busy) return busy
  const job = runSync(brandId)
    .finally(() => {
      syncing.delete(brandId)
      changed(brandId)
    })
    // the state after the busy flag is off
    .then(() => channelState(brandId))
  syncing.set(brandId, job)
  changed(brandId)
  return job
}

// ---------- views ----------

export async function mapView(brandId: string): Promise<ContentMapView> {
  const m = await loadMap(brandId)
  const now = Date.now()
  const list = rows(m.videos, m.pillars, now)
  const pillars = m.pillars.map((p) => ({ ...groupStat(p.label, list.filter((r) => r.pillar === p.label)), label: p.label, keywords: p.keywords, id: p.id }))
  const none = list.filter((r) => !r.pillar && r.platform !== 'local')
  if (m.pillars.length && none.length) pillars.push({ ...groupStat('No pillar', none), label: 'No pillar', keywords: [], id: '' })
  return { channel: await channelState(brandId), baselines: baselines(m.videos, now), pillars, keywords: topKeywords(m.videos), rows: list, worked: whatWorked(list) }
}

function otherDips(m: MapFile, except: string): { dips: Dip[]; duration: number }[] {
  return m.videos
    .filter((v) => v.id !== except && v.retention.length > 1 && v.duration)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, 8)
    .map((v) => ({ dips: findDips(v.retention, v.duration as number), duration: v.duration as number }))
}

export async function videoDetail(brandId: string, videoId: string): Promise<VideoDetail | null> {
  const m = await loadMap(brandId)
  const video = m.videos.find((v) => v.id === videoId)
  if (!video) return null
  const row = rows(m.videos, m.pillars, Date.now()).find((r) => r.id === videoId)
  if (!row) return null
  const local = video.projectId ? (await localInfos(brandId)).find((l) => l.projectId === video.projectId) : undefined
  return {
    video,
    row,
    snapshots: m.tracked.find((t) => t.id === videoId)?.taken ?? [],
    retention: summarizeRetention(video.retention, video.duration, local?.lines ?? [], local?.script ?? [], otherDips(m, videoId))
  }
}

// a video by id, url or a bit of its title
export async function findVideo(brandId: string, ref: string): Promise<MapVideo | null> {
  const m = await loadMap(brandId)
  const id = ref.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1] ?? ref.trim()
  return m.videos.find((v) => v.id === id) ?? m.videos.find((v) => v.title.toLowerCase().includes(ref.trim().toLowerCase())) ?? null
}

export async function setPillars(brandId: string, list: { label: string; keywords: string[]; why: string }[], mode: 'add' | 'replace'): Promise<Pillar[]> {
  return changeMap(brandId, (m) => {
    const now = Date.now()
    const incoming: Pillar[] = list.map((p) => ({ id: randomUUID().slice(0, 8), label: p.label.trim().slice(0, 60), keywords: p.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 20), why: p.why.trim().slice(0, 300), createdAt: now }))
    const kept = mode === 'replace' ? [] : m.pillars.filter((p) => !incoming.some((x) => x.label.toLowerCase() === p.label.toLowerCase()))
    m.pillars = [...kept, ...incoming].slice(0, 12)
    return m.pillars
  })
}

export async function removePillar(brandId: string, pillarId: string): Promise<void> {
  await changeMap(brandId, (m) => void (m.pillars = m.pillars.filter((p) => p.id !== pillarId)))
  changed(brandId)
}

export async function setProject(brandId: string, videoId: string, projectId: string | null): Promise<void> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (projectId && !brand?.projects.some((p) => p.id === projectId)) throw new Error('No project with that id')
  await changeMap(brandId, (m) => {
    const v = m.videos.find((x) => x.id === videoId)
    if (!v) throw new Error('No video with that id')
    v.projectId = projectId
    v.projectPinned = true
  })
  void sync(brandId).catch(() => {})
}

// YouTube Studio's Content export: impressions and CTR for each video
export async function importCsv(brandId: string, text: string): Promise<{ matched: number; rows: number }> {
  const parsed = parseStudioCsv(text)
  if (!parsed.length) throw new Error('No video rows with impressions or CTR in that file. Export the Content table from YouTube Studio, Analytics, Advanced mode.')
  let matched = 0
  await changeMap(brandId, (m) => {
    for (const r of parsed) {
      const v = m.videos.find((x) => x.id === r.id)
      if (!v) continue
      matched++
      const base = v.metrics ?? { views: r.views, engagedViews: null, avgViewDuration: null, avgViewPercent: r.avgViewPercent, likes: null, comments: null, shares: null, subsGained: null, impressions: null, ctr: null, at: Date.now(), sources: [] }
      v.metrics = { ...base, impressions: r.impressions, ctr: r.ctr, sources: [...new Set([...base.sources, 'csv' as const])] }
    }
    m.csvImportedAt = Date.now()
  })
  changed(brandId)
  return { matched, rows: parsed.length }
}

// ---------- snapshots ----------

async function snapshotReader(brandId: string, m: MapFile): Promise<{ read: (ids: string[], labels: Map<string, SnapshotLabel>) => Promise<Reading[]>; cost: (ids: string[]) => number } | null> {
  const auth = await loadAuth(brandId)
  const key = getData()?.settings.youtubeApiKey ?? ''
  if (auth || key) {
    return {
      cost: () => 1,
      read: async (ids, labels) => {
        const counter: Counter = { units: 0, analyticsCalls: 0 }
        const a: Auth = auth ? { kind: 'oauth', token: await accessToken(brandId) } : { kind: 'key', key }
        const list = await fetchVideoList(fetchJson, a, ids, counter, Date.now())
        const out: Reading[] = list.map((v) => ({ id: v.id, views: v.metrics?.views ?? null, engagedViews: null, likes: v.metrics?.likes ?? null, comments: v.metrics?.comments ?? null, avgViewPercent: null, source: 'data-api' }))
        // from 2 days on the Analytics API has watch time, it lags 48 to 72 hours
        if (auth && ids.some((id) => ['48h', '7d', '28d'].includes(labels.get(id) ?? ''))) {
          try {
            const token = await accessToken(brandId)
            const published = Math.min(...ids.map((id) => m.tracked.find((t) => t.id === id)?.publishedAt ?? Date.now()))
            const metrics = await fetchVideoMetrics(fetchJson, token, published - DAY, Date.now(), counter)
            for (const r of out) {
              const x = metrics.get(r.id)
              if (!x) continue
              r.engagedViews = x.engagedViews ?? null
              r.avgViewPercent = x.avgViewPercent ?? null
              r.source = 'analytics'
            }
          } catch {
            // the counts are still worth keeping
          }
        }
        return out
      }
    }
  }
  if (m.publicChannel || m.channelId) {
    return {
      cost: () => 0,
      read: async (ids) => {
        const id = isChannelId(m.channelId) ? m.channelId : m.publicChannel.startsWith('UC') ? m.publicChannel : ''
        if (!id) throw new Error('The channel id is not known yet, sync once first')
        const feed = parseRss(await fetchText(rssUrl(id)), Date.now())
        return feed.videos.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, views: v.metrics?.views ?? null, engagedViews: null, likes: v.metrics?.likes ?? null, comments: null, avgViewPercent: null, source: 'rss' as const }))
      }
    }
  }
  return null
}

// post-mortems whose snapshot is in but whose card couldn't be made yet, e.g. the brand had no chat
async function pendingPostMortems(brandId: string, m: MapFile, now: number): Promise<void> {
  for (const t of m.tracked) {
    for (const s of t.taken) {
      if ((s.label !== '48h' && s.label !== '7d') || now - s.at > 7 * DAY || m.postMortems.includes(`${t.id}:${s.label}`)) continue
      await postMortem(brandId, t.id, s.label).catch((err) => console.error('content map: post-mortem failed', err))
    }
  }
}

export async function snapshotTick(brandId: string): Promise<void> {
  const m = await loadMap(brandId)
  const now = Date.now()
  await pendingPostMortems(brandId, m, now)
  const open = m.tracked.filter((t) => !finished(t, now))
  if (!open.length) return
  const reader = await snapshotReader(brandId, m)
  if (!reader) return
  const result = await tick({ tracked: open, quota: m.quota, backoff: m.backoff }, now, reader.read, reader.cost)
  await changeMap(brandId, (map) => {
    const byId = new Map(result.state.tracked.map((t) => [t.id, t]))
    map.tracked = map.tracked.map((t) => byId.get(t.id) ?? t)
    map.quota = result.state.quota
    map.backoff = result.state.backoff
    // the freshest counts go on the catalog too
    for (const { id } of result.taken) {
      const snap = byId.get(id)?.taken.at(-1)
      const v = map.videos.find((x) => x.id === id)
      if (snap && v) {
        v.metrics ??= { views: null, engagedViews: null, avgViewDuration: null, avgViewPercent: null, likes: null, comments: null, shares: null, subsGained: null, impressions: null, ctr: null, at: snap.at, sources: [snap.source] }
        if (snap.views !== null) v.metrics.views = Math.max(v.metrics.views ?? 0, snap.views)
        if (snap.likes !== null) v.metrics.likes = snap.likes
        if (snap.comments !== null) v.metrics.comments = snap.comments
        v.metrics.at = snap.at
      }
    }
  })
  if (result.taken.length || result.error) changed(brandId)
  for (const t of result.taken) {
    if (t.label === '48h' || t.label === '7d') await postMortem(brandId, t.id, t.label).catch((err) => console.error('content map: post-mortem failed', err))
  }
}

// ---------- post-mortems ----------

// the chat it goes to: the newest chat linked to the video's project, else the newest chat
async function targetThread(brandId: string, projectId: string | null): Promise<string | null> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  const threads = (await threadsFor(brandId)).filter((t) => !t.archived).sort((a, b) => b.updatedAt - a.updatedAt)
  if (projectId && brand?.chatProjects) {
    const linked = threads.find((t) => brand.chatProjects?.[t.id]?.includes(projectId))
    if (linked) return linked.id
  }
  return threads[0]?.id ?? null
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

export async function postMortem(brandId: string, videoId: string, stage: '48h' | '7d'): Promise<PostMortemCard | null> {
  const key = `${videoId}:${stage}`
  let m = await loadMap(brandId)
  if (m.postMortems.includes(key)) return null
  const video = m.videos.find((v) => v.id === videoId)
  const tracked = m.tracked.find((t) => t.id === videoId)
  if (!video || !tracked) return null
  // the newest curve first, it's what the card is about
  if (await loadAuth(brandId)) {
    try {
      const counter: Counter = { units: 0, analyticsCalls: 0 }
      const pts = await fetchRetention(fetchJson, await accessToken(brandId), videoId, (video.publishedAt ?? Date.now()) - DAY, Date.now(), counter)
      if (pts.length) {
        await changeMap(brandId, (map) => {
          const v = map.videos.find((x) => x.id === videoId)
          if (v) {
            v.retention = pts
            v.retentionAt = Date.now()
          }
        })
        m = await loadMap(brandId)
      }
    } catch {
      // the Analytics API can lag past 48 hours, the card says so
    }
  }
  const detail = await videoDetail(brandId, videoId)
  const age = ageRatio(tracked, m.tracked, stage)
  const r = detail?.retention ?? { duration: video.duration, at30: null, dips: [], spikes: [] }
  const usual30 = median(
    m.videos
      .filter((v) => v.id !== videoId && v.retention.length > 1 && (v.duration ?? 0) >= 60)
      .map((v) => {
        const p = v.retention.find((x) => x.ratio * (v.duration as number) >= 30)
        return p?.watch ?? NaN
      })
  )
  const parts: string[] = []
  const learnings: Learning[] = []
  const add = (text: string): void => void learnings.push({ id: randomUUID().slice(0, 8), text, state: 'proposed' })
  if (age.ratio !== null) {
    parts.push(`At ${SNAPSHOT_NAMES[stage]} it has ${age.views?.toLocaleString('en-US')} views, ${ratioText(age.ratio)} what your recent videos had at that age.`)
    if (age.ratio < 0.8) parts.push('Fewer people clicked or were shown it than usual, so look at the title and thumbnail first.')
  } else if (age.views !== null) {
    parts.push(`At ${SNAPSHOT_NAMES[stage]} it has ${age.views.toLocaleString('en-US')} views. There aren't 3 earlier videos with a snapshot at this age to compare with yet.`)
  }
  if (r.at30 !== null) {
    parts.push(`${pct(r.at30)} were still watching at 30 seconds${usual30 !== null ? `, your usual is ${pct(usual30)}` : ''}.`)
    if (usual30 !== null && r.at30 < usual30 - 0.05) add(`The hook of "${video.title}" kept ${pct(r.at30)} at 30 s against a usual ${pct(usual30)}. It opened with: "${video.hook.slice(0, 160)}"`)
  }
  for (const d of r.dips.slice(0, 3)) {
    const where = d.line ? ` while you said "${d.line.slice(0, 140)}"` : ''
    add(`${clock(d.from)} in "${video.title}": ${pct(d.drop)} left in ${Math.max(1, Math.round(d.to - d.from))} s${where}.${d.recurring ? ' Other recent videos dropped at the same point too.' : ''}`)
  }
  if (!video.retention.length) {
    parts.push((await loadAuth(brandId)) ? "YouTube hasn't processed the retention curve yet, it usually takes 2 to 3 days." : 'Connect the channel with Google in Settings, Channels to see where people left.')
  } else if (!r.dips.length) parts.push('No sharp drops on the retention curve.')
  else if (!r.dips.some((d) => d.line)) parts.push("The project has no captions or take with times, so the drops can't be matched to lines.")

  const threadId = await targetThread(brandId, video.projectId)
  if (!threadId) return null
  const now = Date.now()
  const card: PostMortemCard = {
    id: newCardId(),
    brandId,
    threadId,
    messageId: null,
    at: now,
    updatedAt: now,
    type: 'post-mortem',
    videoId,
    title: video.title,
    stage,
    ratio: age.ratio,
    views: age.views,
    at30: r.at30,
    dips: r.dips,
    summary: parts.join(' '),
    learnings
  }
  await addCard(card)
  await changeMap(brandId, (map) => void map.postMortems.push(key))
  return card
}

async function learningCard(brandId: string, cardId: string): Promise<PostMortemCard> {
  const c = await getCard(brandId, cardId)
  if (!c || c.type !== 'post-mortem') throw new Error('That post-mortem card is gone.')
  return c
}

export async function keepLearning(brandId: string, cardId: string, learningId: string, text: string): Promise<unknown> {
  const card = await learningCard(brandId, cardId)
  const l = card.learnings.find((x) => x.id === learningId)
  if (!l) throw new Error('That learning is gone.')
  if (l.state !== 'proposed') throw new Error('This one was already decided.')
  const clean = text.replace(/\s+/g, ' ').trim() || l.text
  await addLearning(brandId, `Post-mortem at ${SNAPSHOT_NAMES[card.stage]}: ${clean}`)
  return changeCard(brandId, cardId, (c) => {
    if (c.type !== 'post-mortem') return
    const x = c.learnings.find((y) => y.id === learningId)
    if (x) {
      x.state = 'kept'
      x.text = clean
    }
  })
}

export async function dropLearning(brandId: string, cardId: string, learningId: string): Promise<unknown> {
  await learningCard(brandId, cardId)
  return changeCard(brandId, cardId, (c) => {
    if (c.type !== 'post-mortem') return
    const x = c.learnings.find((y) => y.id === learningId)
    if (x && x.state === 'proposed') x.state = 'dropped'
  })
}

export async function ownLearning(brandId: string, cardId: string, text: string): Promise<unknown> {
  const card = await learningCard(brandId, cardId)
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('Write the learning first.')
  await addLearning(brandId, `Post-mortem of "${card.title}" at ${SNAPSHOT_NAMES[card.stage]}: ${clean.slice(0, 500)}`)
  return changeCard(brandId, cardId, (c) => {
    if (c.type === 'post-mortem') c.learnings.push({ id: randomUUID().slice(0, 8), text: clean.slice(0, 500), state: 'kept' })
  })
}

// a YouTube post TrendDeck made: it joins the schedule from its post time, before the next sync
export async function trackPosted(brandId: string, videoId: string, title: string, url: string, at: number): Promise<void> {
  await changeMap(brandId, (m) => {
    if (!m.tracked.some((t) => t.id === videoId)) m.tracked.push({ id: videoId, publishedAt: at, taken: [], missed: [] })
    if (!m.videos.some((v) => v.id === videoId)) {
      m.videos.unshift(blank({ id: videoId, platform: 'youtube', title, url, publishedAt: at, duration: null, format: formatOf(null, { shortsLink: /\/shorts\//.test(url), text: title }), thumbnailText: '', tags: [], description: '', metrics: null }))
    }
  })
  changed(brandId)
}
