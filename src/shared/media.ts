// media library types, used by main, preload and the ui

export type MediaKind = 'video' | 'image' | 'audio' | 'file'

export interface MediaPost {
  // lowercase site name, e.g. "youtube", "tiktok"
  platform: string
  at: number
  url: string
}

// what an agent is allowed to know about a file, never the path
export interface MediaInfo {
  id: string
  brandId: string
  name: string
  kind: MediaKind
  ext: string
  size: number
  // seconds, video and audio only once probed
  duration: number | null
  width: number | null
  height: number | null
  tags: string[]
  collections: string[]
  addedAt: number
  posts: MediaPost[]
  agentAllowed: boolean
  missing: boolean
}

// the full record, only the app itself sees this
export interface MediaItem extends MediaInfo {
  path: string
  // true when the file lives in TrendDeck's own folder
  copied: boolean
  // the watch folder it came from, '' when added by hand
  watchId: string
  hasThumb: boolean
  // set once the ui has tried to read duration and size
  probed: boolean
}

export interface WatchFolder {
  id: string
  path: string
  // new files from this folder get the agent switch on
  agentAllowed: boolean
  addedAt: number
}

export interface MediaLibrary {
  brandId: string
  items: MediaItem[]
  collections: string[]
  watch: WatchFolder[]
  // copy new files in instead of linking them
  copyByDefault: boolean
}

export interface MediaFilter {
  query?: string
  kind?: MediaKind
  tag?: string
  collection?: string
  // only files that were never posted, or never posted to this platform
  notPostedTo?: string | true
  postedTo?: string
  // agent calls always set this
  agentOnly?: boolean
  includeMissing?: boolean
}

export interface MediaEdit {
  name?: string
  tags?: string[]
  collections?: string[]
  agentAllowed?: boolean
}

export interface MediaProbe {
  duration: number | null
  width: number | null
  height: number | null
  // jpeg data url, small
  thumb: string | null
}

export interface AddResult {
  added: number
  skipped: number
  // library ids for the files, including ones that were already in the library
  ids: string[]
}

// what the ui can call, there is no way to get a file's contents through here
export interface MediaApi {
  library(brandId: string): Promise<MediaLibrary>
  // for the picker and anything else that should never see paths
  list(brandId: string, filter: MediaFilter): Promise<MediaInfo[]>
  pickAndAdd(brandId: string, folders: boolean): Promise<AddResult>
  addPaths(brandId: string, paths: string[]): Promise<AddResult>
  saveRecording(brandId: string, name: string, mimeType: string, bytes: ArrayBuffer): Promise<AddResult>
  // path of a dropped File, the renderer can't read it on its own
  pathForFile(file: File): string
  edit(brandId: string, ids: string[], edit: MediaEdit): Promise<void>
  remove(brandId: string, ids: string[]): Promise<void>
  undoRemove(brandId: string, ids: string[]): Promise<void>
  copyIn(brandId: string, ids: string[]): Promise<void>
  relink(brandId: string, id: string): Promise<boolean>
  reveal(brandId: string, id: string): Promise<void>
  markPosted(brandId: string, id: string, platform: string, url: string): Promise<void>
  unmarkPosted(brandId: string, id: string, platform: string, at: number): Promise<void>
  setProbe(brandId: string, id: string, probe: MediaProbe): Promise<void>
  setCollections(brandId: string, collections: string[]): Promise<void>
  setCopyByDefault(brandId: string, on: boolean): Promise<void>
  addWatch(brandId: string): Promise<void>
  editWatch(brandId: string, watchId: string, agentAllowed: boolean): Promise<void>
  removeWatch(brandId: string, watchId: string): Promise<void>
  onChange(fn: (brandId: string) => void): () => void
}

export const MEDIA_SCHEME = 'td-media'

// url the app window uses to show a file or its thumbnail
export function mediaUrl(brandId: string, id: string, thumb = false): string {
  return `${MEDIA_SCHEME}://${thumb ? 'thumb' : 'file'}/${brandId}/${id}`
}

const KINDS: Record<string, MediaKind> = {}
for (const e of ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv']) KINDS[e] = 'video'
for (const e of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'svg']) KINDS[e] = 'image'
for (const e of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'weba']) KINDS[e] = 'audio'

export function kindOf(ext: string): MediaKind {
  return KINDS[ext.toLowerCase()] ?? 'file'
}

// files a watch folder picks up, everything else in there is left alone
export function isMediaExt(ext: string): boolean {
  return kindOf(ext) !== 'file'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatDuration(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

// one filter for the page, the picker and agents so they always agree
export function filterMedia<T extends MediaInfo>(items: T[], f: MediaFilter): T[] {
  const q = norm(f.query ?? '')
  const words = q ? q.split(/\s+/) : []
  const tag = f.tag ? norm(f.tag) : ''
  const notPosted = typeof f.notPostedTo === 'string' ? norm(f.notPostedTo) : f.notPostedTo
  const postedTo = f.postedTo ? norm(f.postedTo) : ''
  return items.filter((m) => {
    if (f.agentOnly && !m.agentAllowed) return false
    if (!f.includeMissing && m.missing) return false
    if (f.kind && m.kind !== f.kind) return false
    if (tag && !m.tags.some((t) => norm(t) === tag)) return false
    if (f.collection && !m.collections.includes(f.collection)) return false
    if (notPosted === true && m.posts.length > 0) return false
    if (typeof notPosted === 'string' && m.posts.some((p) => p.platform === notPosted)) return false
    if (postedTo && !m.posts.some((p) => p.platform === postedTo)) return false
    if (words.length) {
      const hay = `${m.name} ${m.ext} ${m.tags.join(' ')} ${m.collections.join(' ')}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    return true
  })
}
