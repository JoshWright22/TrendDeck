import {
  isHttpUrl,
  STAT_PLATFORMS,
  type AnalyticsConfig,
  type AnalyticsDoc,
  type StatPlatform,
  type StatPost,
  type StatRun,
  type StatSnapshot
} from '@shared/types'

// a year of daily refreshes on all three is about 1100, keep a bit more
const MAX_SNAPSHOTS = 1500
const MAX_POSTS = 30

export function defaultConfig(): AnalyticsConfig {
  return {
    enabled: { youtube: true, tiktok: true, instagram: true },
    youtubeChannel: '',
    instagramToken: '',
    tiktokToken: ''
  }
}

const isPlatform = (p: unknown): p is StatPlatform => (STAT_PLATFORMS as readonly unknown[]).includes(p)

// numbers from pages can be anything, keep only real non negative ones
export function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function cleanConfig(raw: unknown): AnalyticsConfig {
  const c = raw as Partial<AnalyticsConfig> | null
  const base = defaultConfig()
  const enabled = { ...base.enabled }
  for (const p of STAT_PLATFORMS) {
    const v = (c?.enabled as Record<string, unknown> | undefined)?.[p]
    if (typeof v === 'boolean') enabled[p] = v
  }
  return {
    enabled,
    youtubeChannel: str(c?.youtubeChannel, 120).trim(),
    instagramToken: str(c?.instagramToken, 600).trim(),
    tiktokToken: str(c?.tiktokToken, 600).trim()
  }
}

export function cleanPost(raw: unknown): StatPost | null {
  const p = raw as Partial<StatPost> | null
  if (!p || typeof p.id !== 'string' || !p.id) return null
  const url = typeof p.url === 'string' && isHttpUrl(p.url) ? p.url : ''
  return {
    id: p.id.slice(0, 120),
    title: str(p.title, 300),
    url,
    publishedAt: num(p.publishedAt),
    views: num(p.views),
    likes: num(p.likes),
    comments: num(p.comments)
  }
}

export function cleanSnapshot(raw: unknown): StatSnapshot | null {
  const s = raw as Partial<StatSnapshot> | null
  if (!s || !isPlatform(s.platform)) return null
  const at = num(s.at)
  if (!at) return null
  const posts = Array.isArray(s.posts) ? s.posts.map(cleanPost).filter((p): p is StatPost => p !== null) : []
  return {
    at,
    platform: s.platform,
    via: s.via === 'api' ? 'api' : 'page',
    account: str(s.account, 120),
    followers: num(s.followers),
    views: num(s.views),
    likes: num(s.likes),
    postCount: num(s.postCount),
    posts: posts.slice(0, MAX_POSTS)
  }
}

function cleanRun(raw: unknown): StatRun | null {
  const r = raw as Partial<StatRun> | null
  if (!r) return null
  return { at: num(r.at) ?? 0, ok: r.ok === true, message: str(r.message, 300) }
}

export function cleanAnalyticsDoc(raw: unknown): AnalyticsDoc {
  const d = raw as Partial<AnalyticsDoc> | null
  const snapshots = Array.isArray(d?.snapshots)
    ? d.snapshots.map(cleanSnapshot).filter((s): s is StatSnapshot => s !== null)
    : []
  snapshots.sort((a, b) => a.at - b.at)
  const lastRun: AnalyticsDoc['lastRun'] = {}
  for (const p of STAT_PLATFORMS) {
    const r = cleanRun((d?.lastRun as Record<string, unknown> | undefined)?.[p])
    if (r) lastRun[p] = r
  }
  return { config: cleanConfig(d?.config), snapshots: snapshots.slice(-MAX_SNAPSHOTS), lastRun }
}

// "1.2K", "3,401", "1,2 M", "12.5万" style counts from page text
export function parseCount(text: unknown): number | null {
  if (typeof text === 'number') return num(text)
  if (typeof text !== 'string') return null
  const m = text.replace(/\s/g, '').match(/([\d.,]+)([KkMmBb万億]?)/)
  if (!m) return null
  let digits = m[1]
  const unit = m[2].toUpperCase()
  if (unit) {
    // with a unit the separator is a decimal point, "1,2M" is 1.2M
    digits = digits.replace(',', '.')
  } else {
    digits = digits.replace(/[.,](?=\d{3}(\D|$))/g, '')
  }
  const n = parseFloat(digits)
  if (!Number.isFinite(n)) return null
  const mult: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 億: 1e8 }
  return Math.round(n * (mult[unit] ?? 1))
}
