// the brand's content map: every past video with its numbers, the channel's own baseline per
// format, pillars, and how each video did against that baseline. main builds it from the
// creator's own YouTube (OAuth), public channel data, the logged-in readers and the project
// folders, and keeps a snapshot series for each new video. shared by main, preload and the ui.
// logins, keys and tokens never come through here

export const MAP_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'local'] as const
export type MapPlatform = (typeof MAP_PLATFORMS)[number]

export const PLATFORM_NAMES: Record<MapPlatform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  local: 'Not posted yet'
}

// shorts, reels and tiktoks are short. youtube calls anything up to 3 minutes a short
export type VideoFormat = 'long' | 'short'
export const SHORT_MAX_SECONDS = 180

export const FORMAT_NAMES: Record<VideoFormat, string> = { long: 'Long videos', short: 'Shorts' }

// where a number came from, so the card can say so
export type MetricSource = 'analytics' | 'data-api' | 'rss' | 'page' | 'csv'

// one point of a retention curve: how far into the video (0 to 1) and the share of views still
// watching there. watch can go above 1 where people rewatch
export interface RetentionPoint {
  ratio: number
  watch: number
}

export interface VideoMetrics {
  views: number | null
  // YouTube Shorts: views that weren't swiped away in the first moment. counts since Aug 2026
  engagedViews: number | null
  // seconds
  avgViewDuration: number | null
  // 0 to 100
  avgViewPercent: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  subsGained: number | null
  impressions: number | null
  // percent, 0 to 100
  ctr: number | null
  at: number
  sources: MetricSource[]
}

export type TextSource = 'captions' | 'take' | 'transcript' | 'script' | ''

export interface Pacing {
  wpm: number
  // pauses of 0.6 s or more, per minute
  pausesPerMin: number
  longestPause: number
  source: TextSource
  // word times spread over caption cues, not measured per word
  approximate: boolean
}

export interface MapVideo {
  // the platform's id, or local:<project id> for a project that isn't matched to a post
  id: string
  platform: MapPlatform
  title: string
  url: string
  publishedAt: number | null
  // seconds
  duration: number | null
  format: VideoFormat
  thumbnailText: string
  tags: string[]
  description: string
  // the first ~30 s of what's said
  hook: string
  hookSource: TextSource
  pacing: Pacing | null
  metrics: VideoMetrics | null
  retention: RetentionPoint[]
  retentionAt: number | null
  projectId: string | null
  // set when the creator picked the project, not matched by title
  projectPinned: boolean
}

// a reading at a fixed age after publish
export const SNAPSHOT_LABELS = ['1h', '6h', '24h', '48h', '7d', '28d'] as const
export type SnapshotLabel = (typeof SNAPSHOT_LABELS)[number]

export const SNAPSHOT_NAMES: Record<SnapshotLabel, string> = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '1 day',
  '48h': '2 days',
  '7d': '7 days',
  '28d': '28 days'
}

export interface VideoSnapshot {
  label: SnapshotLabel
  // when it was due and when it was read. late when the app was closed at the time
  due: number
  at: number
  views: number | null
  engagedViews: number | null
  likes: number | null
  comments: number | null
  avgViewPercent: number | null
  source: MetricSource
}

export interface Pillar {
  id: string
  label: string
  keywords: string[]
  why: string
  createdAt: number
}

// how a video did against the channel's own recent comparable videos
export type Flag = 'top' | 'bottom' | 'normal' | 'early' | 'none'

export interface MapRow {
  id: string
  platform: MapPlatform
  title: string
  url: string
  publishedAt: number | null
  format: VideoFormat
  duration: number | null
  views: number | null
  avgViewPercent: number | null
  // views (engaged views for Shorts when known) over the baseline at the time, null without numbers
  ratio: number | null
  baseline: number | null
  flag: Flag
  pillar: string | null
  hookStyle: string
  titleStyle: string
  projectId: string | null
  hasRetention: boolean
}

export interface BaselineSummary {
  platform: MapPlatform
  format: VideoFormat
  // median of the most recent comparable videos older than a week
  median: number | null
  count: number
  metric: 'views' | 'engaged views'
}

export interface GroupStat {
  key: string
  count: number
  // median ratio vs baseline, null when none of them have numbers
  median: number | null
  // share of videos with numbers that beat their baseline, 0 to 1
  beat: number | null
  best: { id: string; title: string; ratio: number }[]
}

export interface WhatWorked {
  pillar: GroupStat[]
  format: GroupStat[]
  hookStyle: GroupStat[]
  titleStyle: GroupStat[]
}

export type ConnectionMode = 'oauth' | 'api-key' | 'rss' | 'none'

// what the ui may know about the channel connection. never a token, key or secret
export interface ChannelState {
  mode: ConnectionMode
  channelId: string
  channelTitle: string
  // the public channel, @handle or UC id, used when there's no OAuth
  publicChannel: string
  // a Google OAuth client is saved (app wide), its secret is never sent back
  hasClient: boolean
  clientId: string
  hasApiKey: boolean
  connecting: boolean
  syncing: boolean
  lastSync: number | null
  lastSyncOk: boolean
  lastSyncNote: string
  quotaUsedToday: number
  quotaLimit: number
  // snapshot scheduler is waiting until then after quota or network errors
  backoffUntil: number | null
  videos: number
  // impressions and CTR come from a YouTube Studio export, the targeted API doesn't give them
  csvImportedAt: number | null
}

export interface MappedDip {
  // seconds into the video
  from: number
  to: number
  // share of the audience lost over the dip, 0 to 1
  drop: number
  // how many times steeper than the video's usual decline
  steepness: number
  // the script or caption line said there, '' when the project has none with times
  line: string
  lineSource: TextSource
  // the same spot dropped in other recent videos
  recurring: boolean
}

export interface RetentionSummary {
  duration: number | null
  // share still watching at 30 s (YouTube's "intro"), null for videos under a minute or without data
  at30: number | null
  dips: MappedDip[]
  spikes: { at: number; rise: number }[]
}

export interface VideoDetail {
  video: MapVideo
  row: MapRow
  snapshots: VideoSnapshot[]
  retention: RetentionSummary
}

export interface ContentMapView {
  channel: ChannelState
  baselines: BaselineSummary[]
  pillars: (GroupStat & { label: string; keywords: string[]; id: string })[]
  // recurring words in titles and tags, for proposing pillars
  keywords: { word: string; count: number }[]
  rows: MapRow[]
  worked: WhatWorked
}

export interface ContentMapApi {
  view(brandId: string): Promise<ContentMapView>
  detail(brandId: string, videoId: string): Promise<VideoDetail | null>
  sync(brandId: string): Promise<ChannelState>
  // the app wide Google OAuth client for the desktop flow. clientSecret '' keeps the saved one
  setClient(clientId: string, clientSecret: string): Promise<void>
  clearClient(): Promise<void>
  // opens Google's consent page in the browser and waits for the redirect
  connect(brandId: string): Promise<ChannelState>
  disconnect(brandId: string): Promise<ChannelState>
  setPublicChannel(brandId: string, channel: string): Promise<ChannelState>
  // a YouTube Studio "Content" table export, for impressions and CTR. returns how many matched
  importCsv(brandId: string): Promise<{ matched: number; rows: number } | null>
  removePillar(brandId: string, pillarId: string): Promise<void>
  setProject(brandId: string, videoId: string, projectId: string | null): Promise<void>
  keepLearning(brandId: string, cardId: string, learningId: string, text: string): Promise<unknown>
  dropLearning(brandId: string, cardId: string, learningId: string): Promise<unknown>
  addLearning(brandId: string, cardId: string, text: string): Promise<unknown>
  onChanged(fn: (brandId: string) => void): () => void
}

declare global {
  interface Window {
    trenddeckContentMap: ContentMapApi
  }
}

// "1:05", "12:40", "1:02:03"
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

// 1.42 -> "1.4x"
export function ratioText(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return 'no data'
  return `${r >= 10 ? Math.round(r) : r.toFixed(r < 1 ? 2 : 1)}x`
}

// 12345 -> "12,345", 1234567 -> "1.2M"
export function countText(n: number | null): string {
  if (n === null) return 'no data'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  return n.toLocaleString('en-US')
}
