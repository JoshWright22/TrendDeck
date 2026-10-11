import type { PostingApi } from './posting'
import type { MediaApi } from './media'

export interface Site {
  id: string
  name: string
  url: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: number
}

export interface ChatThread {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

export interface Idea {
  id: string
  title: string
  url: string
  source: TrendSource | 'manual'
  savedAt: number
  // board fields, missing on ideas saved before the board existed
  stage?: IdeaStage
  notes?: string
  tags?: string[]
  postedAt?: number
}

export const IDEA_STAGES = ['idea', 'outline', 'recorded', 'edited', 'posted'] as const
export type IdeaStage = (typeof IDEA_STAGES)[number]

export const STAGE_NAMES: Record<IdeaStage, string> = {
  idea: 'Idea',
  outline: 'Outline',
  recorded: 'Recorded',
  edited: 'Edited',
  posted: 'Posted'
}

export const PLATFORMS = ['YouTube', 'Shorts', 'TikTok', 'Instagram', 'X', 'Reddit', 'Other'] as const

// one planned post on the schedule
export interface ScheduleSlot {
  id: string
  // local time the post goes out, ms
  at: number
  platform: string
  title: string
  // '' when no idea is linked
  ideaId: string
  // the post text, caption or script notes for this slot
  draft: string
  done: boolean
}

export interface Brand {
  id: string
  name: string
  keywords: string[]
  // without the r/
  subreddits: string[]
  // ad blocker for every site of this brand
  adblock: boolean
  // domains the blocker leaves alone, subdomains included
  adblockAllow: string[]
  sites: Site[]
  threads: ChatThread[]
  ideas: Idea[]
  schedule?: ScheduleSlot[]
}

export interface Settings {
  // optional, youtube search pages are used when it's empty
  youtubeApiKey: string
}

export interface AppData {
  version: 1
  activeBrandId: string | null
  chatOpen: boolean
  settings: Settings
  brands: Brand[]
}

export const TREND_SOURCES = ['reddit', 'youtube', 'google', 'tiktok'] as const
export type TrendSource = (typeof TREND_SOURCES)[number]

export const SOURCE_NAMES: Record<TrendSource, string> = {
  reddit: 'Reddit',
  youtube: 'YouTube',
  google: 'Google Trends',
  tiktok: 'TikTok'
}

export interface TrendItem {
  // source plus the source's own id, stable between refreshes
  id: string
  source: TrendSource
  title: string
  url: string
  // one short line, e.g. "r/buildapc, 1.2K upvotes"
  detail: string
  publishedAt: number | null
  // raw growth for the source: upvotes or views per hour, search % rise
  velocity: number
  // velocity squashed to 0-100 against the rest of the same source
  score: number
  // [time, value] points for the little trend line
  points: [number, number][]
}

export interface TrendFeed {
  brandId: string
  fetchedAt: number
  items: TrendItem[]
  // sources that failed on the last refresh, with why
  errors: Partial<Record<TrendSource, string>>
  refreshing: boolean
}

export const DEFAULT_SITES: ReadonlyArray<Omit<Site, 'id'>> = [
  { name: 'Reddit', url: 'https://www.reddit.com' },
  { name: 'X', url: 'https://x.com' },
  { name: 'Instagram', url: 'https://www.instagram.com' },
  { name: 'TikTok', url: 'https://www.tiktok.com' },
  { name: 'YouTube', url: 'https://www.youtube.com' },
  { name: 'YouTube Studio', url: 'https://studio.youtube.com' },
  { name: 'vidIQ', url: 'https://app.vidiq.com' },
  { name: '1of10', url: 'https://1of10.com' }
]

// brand ids end up in a session partition name, so keep them boring
export const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/

export function partitionFor(brandId: string): string {
  return `persist:brand-${brandId}`
}

// hostname without the www, '' when it isn't a url
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// last two labels, good enough to match youtube.com links to a youtube tab
export function baseDomain(host: string): string {
  return host.split('.').slice(-2).join('.')
}

// "https://www.Example.com/x" or "example.com" both end up as example.com
export function cleanDomain(raw: string): string {
  const text = raw.trim().toLowerCase()
  const host = hostOf(/^https?:\/\//.test(text) ? text : `https://${text}`)
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) ? host : ''
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export type WindowAction = 'minimize' | 'maximize' | 'close' | 'state'

export interface TrendDeckApi {
  platform: string
  // resolves to whether the window is maximized after the action
  windowControl(action: WindowAction): Promise<boolean>
  onMaximized(fn: (maximized: boolean) => void): () => void
  // a link was clicked somewhere, open it in a site tab
  onOpenUrl(fn: (url: string) => void): () => void
  loadData(): Promise<AppData>
  saveData(data: AppData): Promise<void>
  clearBrandSession(brandId: string): Promise<void>
  // ctrl+1..9 pressed while a site has focus, index is 0 based
  onBrandShortcut(fn: (index: number) => void): () => void
  // cached feed, kicks off a refresh in the background when it's old
  getTrends(brandId: string): Promise<TrendFeed | null>
  refreshTrends(brandId: string): Promise<void>
  onTrends(fn: (feed: TrendFeed) => void): () => void
  loadDrafts(brandId: string): Promise<WriterDoc>
  saveDrafts(brandId: string, doc: WriterDoc): Promise<void>
  loadAnalytics(brandId: string): Promise<AnalyticsDoc>
  saveAnalyticsConfig(brandId: string, config: AnalyticsConfig): Promise<AnalyticsDoc>
  // reads the logged in pages (or apis) for these platforms, one at a time
  refreshAnalytics(brandId: string, platforms: StatPlatform[]): Promise<AnalyticsDoc>
  clearAnalytics(brandId: string): Promise<AnalyticsDoc>
  onAnalyticsProgress(fn: (brandId: string, platform: StatPlatform | null) => void): () => void
  posting: PostingApi
  media: MediaApi
}

// writer: drafts per idea, one file per brand in writer/

export const WRITER_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x', 'reddit'] as const
export type WriterPlatform = (typeof WRITER_PLATFORMS)[number]

export interface DraftVersion {
  id: string
  at: number
  // 'generated' when it came back from the chat agent
  kind: 'manual' | 'generated'
  fields: Record<string, string>
  thread: string[]
}

export interface PlatformDraft {
  // youtube: title, description, tags. tiktok/instagram: caption, hashtags. reddit: title, body
  fields: Record<string, string>
  // x posts, one entry per post in the thread
  thread: string[]
  versions: DraftVersion[]
}

export interface Draft {
  id: string
  // null for a draft that isn't tied to a saved idea
  ideaId: string | null
  title: string
  createdAt: number
  updatedAt: number
  platforms: Record<WriterPlatform, PlatformDraft>
}

export interface WriterDoc {
  drafts: Draft[]
}

// analytics: the user's own numbers, one file per brand in analytics/

export const STAT_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const
export type StatPlatform = (typeof STAT_PLATFORMS)[number]

export interface StatPost {
  id: string
  title: string
  url: string
  publishedAt: number | null
  views: number | null
  likes: number | null
  comments: number | null
}

export interface StatSnapshot {
  at: number
  platform: StatPlatform
  // 'page' when read from the logged in tab, 'api' from an official api key
  via: 'page' | 'api'
  account: string
  followers: number | null
  // lifetime views when the site shows them
  views: number | null
  likes: number | null
  postCount: number | null
  posts: StatPost[]
}

export interface AnalyticsConfig {
  // which platforms refresh reads
  enabled: Record<StatPlatform, boolean>
  // youtube data api uses the key from settings plus a channel id or @handle
  youtubeChannel: string
  instagramToken: string
  tiktokToken: string
}

export interface StatRun {
  at: number
  ok: boolean
  message: string
}

export interface AnalyticsDoc {
  config: AnalyticsConfig
  snapshots: StatSnapshot[]
  lastRun: Partial<Record<StatPlatform, StatRun>>
}
