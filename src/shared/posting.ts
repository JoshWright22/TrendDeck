// posting types, used by main, preload and the posting page

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x', 'reddit'] as const
export type Platform = (typeof PLATFORMS)[number]

export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  x: 'X',
  reddit: 'Reddit'
}

// what each platform needs before a post can go out
export const PLATFORM_RULES: Record<
  Platform,
  { needsMedia: boolean; needsTitle: boolean; bodyMax: number; titleMax: number }
> = {
  youtube: { needsMedia: true, needsTitle: true, bodyMax: 5000, titleMax: 100 },
  tiktok: { needsMedia: true, needsTitle: false, bodyMax: 2200, titleMax: 0 },
  instagram: { needsMedia: true, needsTitle: false, bodyMax: 2200, titleMax: 0 },
  x: { needsMedia: false, needsTitle: false, bodyMax: 280, titleMax: 0 },
  reddit: { needsMedia: false, needsTitle: true, bodyMax: 40000, titleMax: 300 }
}

export type PostStatus =
  // saved, waiting for you to send it
  | 'draft'
  // waits for scheduledAt
  | 'scheduled'
  // waiting for its turn, one post runs at a time
  | 'queued'
  | 'running'
  // the compose page is filled and open, waiting for you to press Post
  | 'review'
  | 'posted'
  | 'failed'
  // the review window got closed before the post went out
  | 'closed'
  // the app was closed when it was due
  | 'missed'

export type PostMode = 'tabs' | 'api'

export type Visibility = 'public' | 'unlisted' | 'private'

export interface PostItem {
  id: string
  brandId: string
  platform: Platform
  // youtube and reddit titles, the rest ignore it
  title: string
  // caption, description or post text
  body: string
  // media library id of the image or video, empty for text posts.
  // main turns it into a path with resolveForUpload right before posting
  mediaId: string
  // an agent asked for this post, its file has to be allowed for agents
  byAgent: boolean
  // instagram api mode needs the media at a public link
  mediaUrl: string
  // reddit only, without the r/
  subreddit: string
  visibility: Visibility
  scheduledAt: number | null
  status: PostStatus
  createdAt: number
  updatedAt: number
  // last error or note, e.g. which step broke
  note: string
  // link to the post when we know it
  url: string
}

// main only: a post with its media id turned into a path, built right before it runs
export interface ReadyPost extends PostItem {
  mediaPath: string
}

export type LogResult = 'posted' | 'failed' | 'review' | 'closed' | 'missed' | 'check'

export interface LogEntry {
  id: string
  at: number
  postId: string | null
  brandId: string
  platform: Platform
  mode: PostMode
  result: LogResult
  message: string
}

export interface BrandPosting {
  // skip the post audit: press the final Post button without waiting for the user.
  // off by default, then every post waits in the brand's tab for you to press Post
  autoPost: boolean
  modes: Record<Platform, PostMode>
  // which api keys are saved, the keys themselves never leave main
  keys: Record<Platform, string[]>
}

export interface PostingState {
  posts: PostItem[]
  log: LogEntry[]
  brands: Record<string, BrandPosting>
}

export type StepState = 'ok' | 'broke' | 'skipped'

export interface StepReport {
  name: string
  state: StepState
  detail: string
}

export interface CheckReport {
  platform: Platform
  at: number
  ok: boolean
  steps: StepReport[]
}

// api key fields per platform, all optional
export const API_FIELDS: Record<Platform, { key: string; label: string; secret: boolean }[]> = {
  youtube: [
    { key: 'clientId', label: 'OAuth client ID (desktop app)', secret: false },
    { key: 'clientSecret', label: 'OAuth client secret', secret: true }
  ],
  tiktok: [{ key: 'accessToken', label: 'User access token (video.publish scope)', secret: true }],
  instagram: [
    { key: 'userId', label: 'Instagram account ID', secret: false },
    { key: 'accessToken', label: 'Access token (instagram_content_publish)', secret: true }
  ],
  x: [{ key: 'accessToken', label: 'OAuth 2.0 user access token (tweet.write, media.write)', secret: true }],
  reddit: []
}

export interface PostingApi {
  get(): Promise<PostingState>
  onUpdate(fn: (state: PostingState) => void): () => void
  // adds or replaces posts, main cleans them first
  save(posts: PostItem[]): Promise<void>
  remove(id: string): Promise<void>
  // runs now, or puts it in line behind the one that's running
  run(id: string): Promise<void>
  markPosted(id: string): Promise<void>
  // brings the review window to the front
  focus(id: string): Promise<boolean>
  setBrand(brandId: string, patch: Partial<Pick<BrandPosting, 'autoPost' | 'modes'>>): Promise<void>
  // empty values are skipped so saved secrets stay put, null clears them all
  setKeys(brandId: string, platform: Platform, values: Record<string, string> | null): Promise<void>
  // youtube needs a browser sign in to get its refresh token
  connectYouTube(brandId: string): Promise<string>
  check(brandId: string, platform: Platform, subreddit: string): Promise<CheckReport>
  clearLog(brandId: string): Promise<void>
  // post audit: main asks the app to bring up the brand's tab for a site
  onOpenSite(fn: (to: { brandId: string; siteId: string; url: string }) => void): () => void
}
