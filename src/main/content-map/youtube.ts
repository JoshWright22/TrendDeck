import { SHORT_MAX_SECONDS, type MapVideo, type RetentionPoint, type VideoFormat, type VideoMetrics } from '@shared/content-map'

// the creator's own YouTube: Data API v3 for the uploads and live counts, Analytics API for
// watch time, retention and subscribers. parsing is pure and tested on fixture shapes; calls go
// through a fetch main gives it, with an OAuth bearer or the public API key. no electron here

export const DATA_API = 'https://www.googleapis.com/youtube/v3'
export const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports'

// the auth a call carries: a bearer token from the creator's login, or the public API key
export type Auth = { kind: 'oauth'; token: string } | { kind: 'key'; key: string }

export type FetchJson = (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>

const MAX_VIDEOS = 300

export function withAuth(url: string, auth: Auth): { url: string; headers: Record<string, string> } {
  if (auth.kind === 'oauth') return { url, headers: { authorization: `Bearer ${auth.token}` } }
  return { url: `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(auth.key)}`, headers: {} }
}

// "PT1H2M3S" -> 3723, "P0D" -> 0
export function isoDuration(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const m = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!m) return null
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Math.round(Number(m[4] ?? 0))
}

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null
}
const s = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '')

// a Short is up to 3 minutes. between 1 and 3 minutes it takes a sign: #shorts, a /shorts/ link,
// or YouTube's own content type
export function formatOf(duration: number | null, hints: { shortsLink?: boolean; text?: string; contentType?: string } = {}): VideoFormat {
  if (hints.contentType === 'SHORTS') return 'short'
  if (hints.contentType === 'VIDEO_ON_DEMAND' || hints.contentType === 'LIVE_STREAM') return 'long'
  if (hints.shortsLink) return 'short'
  if (duration === null) return /#shorts?\b/i.test(hints.text ?? '') ? 'short' : 'long'
  if (duration <= 60) return 'short'
  if (duration <= SHORT_MAX_SECONDS && /#shorts?\b/i.test(hints.text ?? '')) return 'short'
  return 'long'
}

export interface ChannelInfo {
  id: string
  title: string
  uploads: string
}

export function parseChannels(raw: unknown): ChannelInfo | null {
  const items = (raw as { items?: unknown[] } | null)?.items
  const c = Array.isArray(items) ? (items[0] as Record<string, unknown> | undefined) : undefined
  if (!c || typeof c.id !== 'string') return null
  const snippet = c.snippet as { title?: unknown } | undefined
  const uploads = (c.contentDetails as { relatedPlaylists?: { uploads?: unknown } } | undefined)?.relatedPlaylists?.uploads
  return { id: c.id, title: s(snippet?.title, 200), uploads: typeof uploads === 'string' ? uploads : '' }
}

export function parsePlaylistPage(raw: unknown): { ids: string[]; next: string } {
  const r = raw as { items?: { contentDetails?: { videoId?: unknown } }[]; nextPageToken?: unknown } | null
  const ids = (r?.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => typeof x === 'string' && /^[\w-]{6,20}$/.test(x))
  return { ids, next: typeof r?.nextPageToken === 'string' ? r.nextPageToken : '' }
}

type Partial0 = Omit<MapVideo, 'hook' | 'hookSource' | 'pacing' | 'retention' | 'retentionAt' | 'projectId' | 'projectPinned'>

export function parseVideos(raw: unknown, at: number): Partial0[] {
  const items = (raw as { items?: unknown[] } | null)?.items
  if (!Array.isArray(items)) return []
  const out: Partial0[] = []
  for (const it of items) {
    const v = it as Record<string, unknown>
    if (typeof v.id !== 'string') continue
    const sn = (v.snippet ?? {}) as Record<string, unknown>
    const st = (v.statistics ?? {}) as Record<string, unknown>
    const cd = (v.contentDetails ?? {}) as Record<string, unknown>
    const duration = isoDuration(cd.duration)
    const tags = Array.isArray(sn.tags) ? sn.tags.filter((t): t is string => typeof t === 'string').slice(0, 30).map((t) => t.slice(0, 60)) : []
    const description = s(sn.description, 1500)
    const title = s(sn.title, 300)
    const published = Date.parse(s(sn.publishedAt, 40))
    out.push({
      id: v.id,
      platform: 'youtube',
      title,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      publishedAt: Number.isNaN(published) ? null : published,
      duration,
      format: formatOf(duration, { text: `${title} ${description} ${tags.join(' ')}` }),
      thumbnailText: '',
      tags,
      description,
      metrics: {
        views: n(st.viewCount),
        engagedViews: null,
        avgViewDuration: null,
        avgViewPercent: null,
        likes: n(st.likeCount),
        comments: n(st.commentCount),
        shares: null,
        subsGained: null,
        impressions: null,
        ctr: null,
        at,
        sources: ['data-api']
      }
    })
  }
  return out
}

// an Analytics API report as rows of named values
export function parseReport(raw: unknown): Record<string, string | number>[] {
  const r = raw as { columnHeaders?: { name?: unknown }[]; rows?: unknown[][] } | null
  const names = (r?.columnHeaders ?? []).map((h) => (typeof h.name === 'string' ? h.name : ''))
  if (!names.length || !Array.isArray(r?.rows)) return []
  return r.rows.filter(Array.isArray).map((row) => {
    const o: Record<string, string | number> = {}
    names.forEach((name, i) => {
      const v = row[i]
      if (name && (typeof v === 'string' || typeof v === 'number')) o[name] = v
    })
    return o
  })
}

export const VIDEO_METRICS = ['views', 'engagedViews', 'averageViewDuration', 'averageViewPercentage', 'likes', 'comments', 'shares', 'subscribersGained']

export function metricsFromReport(row: Record<string, string | number>): Partial<VideoMetrics> {
  return {
    views: n(row.views),
    engagedViews: n(row.engagedViews),
    avgViewDuration: n(row.averageViewDuration),
    avgViewPercent: n(row.averageViewPercentage),
    likes: n(row.likes),
    comments: n(row.comments),
    shares: n(row.shares),
    subsGained: n(row.subscribersGained)
  }
}

export function parseRetention(raw: unknown): RetentionPoint[] {
  return parseReport(raw)
    .map((r) => ({ ratio: Number(r.elapsedVideoTimeRatio), watch: Number(r.audienceWatchRatio) }))
    .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch))
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 120)
    .map((p) => ({ ratio: Math.round(p.ratio * 1000) / 1000, watch: Math.round(p.watch * 1000) / 1000 }))
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export function reportUrl(metrics: string[], opts: { dimensions?: string; filters?: string; start: number; end: number; sort?: string; maxResults?: number }): string {
  const q = new URLSearchParams({ ids: 'channel==MINE', startDate: day(opts.start), endDate: day(opts.end), metrics: metrics.join(',') })
  if (opts.dimensions) q.set('dimensions', opts.dimensions)
  if (opts.filters) q.set('filters', opts.filters)
  if (opts.sort) q.set('sort', opts.sort)
  if (opts.maxResults) q.set('maxResults', String(opts.maxResults))
  return `${ANALYTICS_API}?${q.toString()}`
}

// ---------- calls ----------

export interface Counter {
  // Data API quota units spent
  units: number
  analyticsCalls: number
}

async function get(fetchJson: FetchJson, auth: Auth, url: string, counter: Counter, units: number): Promise<unknown> {
  const a = withAuth(url, auth)
  if (url.startsWith(DATA_API)) counter.units += units
  else counter.analyticsCalls += 1
  return fetchJson(a.url, { headers: a.headers })
}

export async function fetchChannel(fetchJson: FetchJson, auth: Auth, channel: string, counter: Counter): Promise<ChannelInfo> {
  const who = auth.kind === 'oauth' && !channel ? 'mine=true' : channel.startsWith('@') ? `forHandle=${encodeURIComponent(channel)}` : `id=${encodeURIComponent(channel)}`
  const c = parseChannels(await get(fetchJson, auth, `${DATA_API}/channels?part=snippet,contentDetails&${who}`, counter, 1))
  if (!c) throw new Error(channel ? `YouTube found no channel for ${channel}` : 'This Google account has no YouTube channel')
  return c
}

export async function fetchUploads(fetchJson: FetchJson, auth: Auth, ch: ChannelInfo, counter: Counter, now: number, max = MAX_VIDEOS): Promise<Partial0[]> {
  if (!ch.uploads) return []
  const ids: string[] = []
  let page = ''
  do {
    const url = `${DATA_API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(ch.uploads)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`
    const p = parsePlaylistPage(await get(fetchJson, auth, url, counter, 1))
    ids.push(...p.ids)
    page = p.next
  } while (page && ids.length < max)
  return fetchVideoList(fetchJson, auth, ids.slice(0, max), counter, now)
}

export async function fetchVideoList(fetchJson: FetchJson, auth: Auth, ids: string[], counter: Counter, now: number): Promise<Partial0[]> {
  const out: Partial0[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    out.push(...parseVideos(await get(fetchJson, auth, `${DATA_API}/videos?part=snippet,contentDetails,statistics&id=${batch.join(',')}`, counter, 1), now))
  }
  return out
}

// lifetime numbers per video from the Analytics API. engagedViews is newer, a channel or
// account that doesn't have it gets the rest
export async function fetchVideoMetrics(fetchJson: FetchJson, token: string, since: number, now: number, counter: Counter): Promise<Map<string, Partial<VideoMetrics>>> {
  const auth: Auth = { kind: 'oauth', token }
  const run = async (metrics: string[]): Promise<Record<string, string | number>[]> =>
    parseReport(await get(fetchJson, auth, reportUrl(metrics, { dimensions: 'video', start: since, end: now, sort: '-views', maxResults: 200 }), counter, 0))
  let rows: Record<string, string | number>[]
  try {
    rows = await run(VIDEO_METRICS)
  } catch {
    rows = await run(VIDEO_METRICS.filter((m) => m !== 'engagedViews'))
  }
  const out = new Map<string, Partial<VideoMetrics>>()
  for (const r of rows) if (typeof r.video === 'string') out.set(r.video, metricsFromReport(r))
  return out
}

// YouTube's own Shorts or long label per video, when the channel's report has it
export async function fetchContentTypes(fetchJson: FetchJson, token: string, since: number, now: number, counter: Counter): Promise<Map<string, string>> {
  const rows = parseReport(
    await get(fetchJson, { kind: 'oauth', token }, reportUrl(['views'], { dimensions: 'video,creatorContentType', start: since, end: now, sort: '-views', maxResults: 200 }), counter, 0)
  )
  const out = new Map<string, string>()
  for (const r of rows) if (typeof r.video === 'string' && typeof r.creatorContentType === 'string') out.set(r.video, r.creatorContentType)
  return out
}

export async function fetchRetention(fetchJson: FetchJson, token: string, videoId: string, since: number, now: number, counter: Counter): Promise<RetentionPoint[]> {
  const url = reportUrl(['audienceWatchRatio', 'relativeRetentionPerformance'], { dimensions: 'elapsedVideoTimeRatio', filters: `video==${videoId}`, start: since, end: now })
  return parseRetention(await get(fetchJson, { kind: 'oauth', token }, url, counter, 0))
}

// ---------- public data without a login ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decodeXml(t: string): string {
  return t
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
}

const tag = (xml: string, name: string): string => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? decodeXml(m[1]).trim() : ''
}
const attr = (xml: string, name: string, a: string): string => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*?${a}="([^"]*)"`))
  return m ? decodeXml(m[1]) : ''
}

export const rssUrl = (channelId: string): string => `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`

// the channel's public feed: its 15 newest uploads with views from media:statistics
export function parseRss(xml: string, at: number): { channelTitle: string; channelId: string; videos: Partial0[] } {
  const head = xml.split('<entry')[0] ?? ''
  const channelTitle = tag(head, 'title')
  // the feed's header has dropped the UC prefix at times, the entries and the url keep it
  const raw = tag(head, 'yt:channelId')
  const channelId = /^UC[\w-]{22}$/.test(raw) ? raw : /^[\w-]{22}$/.test(raw) ? `UC${raw}` : ''
  const videos: Partial0[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const id = tag(e, 'yt:videoId')
    if (!/^[\w-]{6,20}$/.test(id)) continue
    const link = attr(e, 'link', 'href')
    const title = tag(e, 'title').slice(0, 300)
    const description = tag(e, 'media:description').slice(0, 1500)
    const published = Date.parse(tag(e, 'published'))
    const views = n(attr(e, 'media:statistics', 'views'))
    const likes = n(attr(e, 'media:starRating', 'count'))
    const shortsLink = /\/shorts\//.test(link)
    videos.push({
      id,
      platform: 'youtube',
      title,
      url: link && /^https:\/\/(www\.)?youtube\.com\//.test(link) ? link : `https://www.youtube.com/watch?v=${id}`,
      publishedAt: Number.isNaN(published) ? null : published,
      duration: null,
      format: formatOf(null, { shortsLink, text: `${title} ${description}` }),
      thumbnailText: '',
      tags: [],
      description,
      metrics: { views, engagedViews: null, avgViewDuration: null, avgViewPercent: null, likes, comments: null, shares: null, subsGained: null, impressions: null, ctr: null, at, sources: ['rss'] }
    })
  }
  return { channelTitle, channelId, videos }
}

// a channel page's own id, for turning @handle into UC... without an API key
export function channelIdFromHtml(html: string): string {
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ??
    html.match(/"externalId":"(UC[\w-]{22})"/) ??
    html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/) ??
    html.match(/"channelId":"(UC[\w-]{22})"/)
  return m?.[1] ?? ''
}

// "@name", "youtube.com/@name", "UC...", "youtube.com/channel/UC..." -> "@name" or "UC..."
export function cleanChannel(input: string): string {
  const t = input.trim()
  const ch = t.match(/(UC[\w-]{22})/)
  if (ch) return ch[1]
  const h = t.match(/@([\w.-]{3,100})/)
  if (h) return `@${h[1]}`
  if (/^[\w.-]{3,100}$/.test(t)) return `@${t}`
  return ''
}

// ---------- YouTube Studio export ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const t = text.replace(/^﻿/, '')
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim()))
}

export interface StudioRow {
  id: string
  impressions: number | null
  ctr: number | null
  views: number | null
  avgViewPercent: number | null
}

// Studio, Analytics, Advanced mode, Content, Export "Table data.csv". the first row after the
// header is the channel total, its Content cell says Total
export function parseStudioCsv(text: string): StudioRow[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const col = (re: RegExp): number => head.findIndex((h) => re.test(h))
  const idCol = col(/^(content|video)$/)
  const imp = col(/^impressions$/)
  const ctr = col(/click-through rate/)
  const views = col(/^views$/)
  const pct = col(/average percentage viewed/)
  if (idCol < 0 || (imp < 0 && ctr < 0)) return []
  const num = (r: string[], i: number): number | null => (i < 0 ? null : n((r[i] ?? '').replace(/[,%\s]/g, '')))
  return rows
    .slice(1)
    .filter((r) => /^[\w-]{6,20}$/.test((r[idCol] ?? '').trim()) && (r[idCol] ?? '').trim().toLowerCase() !== 'total')
    .map((r) => ({ id: r[idCol].trim(), impressions: num(r, imp), ctr: num(r, ctr), views: num(r, views), avgViewPercent: num(r, pct) }))
}
