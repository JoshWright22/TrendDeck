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
}

export interface Settings {
  // optional, youtube search pages are used when it's empty
  youtubeApiKey: string
  // site tabs each brand keeps open in the background
  tabCap: number
  // checks github releases for a new version, packaged builds only
  autoUpdate: boolean
}

export const TAB_CAP_DEFAULT = 6
export const TAB_CAP_MAX = 20

export interface AppData {
  version: 1
  activeBrandId: string | null
  chatOpen: boolean
  // false until the first run setup is done or skipped
  onboarded: boolean
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
  // a kept alive site tab went out of view or came back
  setSiteHidden(webContentsId: number, hidden: boolean): void
}
