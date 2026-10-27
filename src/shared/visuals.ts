// visuals in the chat: sketches you draw, images you paste or drag in, and options found online
// (Openverse, Wikimedia Commons, Pexels, Pixabay). shared by main, preload and the ui

export const VISUAL_KINDS = ['image', 'video', 'gif', 'audio'] as const
export type VisualKind = (typeof VISUAL_KINDS)[number]

export const ORIENTATIONS = ['landscape', 'portrait', 'square'] as const
export type Orientation = (typeof ORIENTATIONS)[number]

// any-free: any open license, some ask for credit or forbid commercial use
// commercial: fine for a monetized video, may still ask for credit
// no-attribution: public domain, CC0 or a provider license that doesn't ask for credit
export const LICENSE_FILTERS = ['any-free', 'commercial', 'no-attribution'] as const
export type LicenseFilter = (typeof LICENSE_FILTERS)[number]

export const PROVIDERS = ['openverse', 'wikimedia', 'pexels', 'pixabay'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  openverse: 'Openverse',
  wikimedia: 'Wikimedia Commons',
  pexels: 'Pexels',
  pixabay: 'Pixabay'
}

// what each provider can search. Pexels and Pixabay need a free key in Settings, Media sources
export const PROVIDER_KINDS: Record<ProviderId, readonly VisualKind[]> = {
  openverse: ['image', 'gif', 'audio'],
  wikimedia: ['image', 'video', 'gif', 'audio'],
  pexels: ['image', 'video'],
  pixabay: ['image', 'video']
}

export const KIND_NAMES: Record<VisualKind, string> = { image: 'Images', video: 'Videos', gif: 'GIFs', audio: 'Audio' }
export const ORIENTATION_NAMES: Record<Orientation, string> = { landscape: 'Landscape', portrait: 'Portrait', square: 'Square' }
export const LICENSE_NAMES: Record<LicenseFilter, string> = {
  'any-free': 'Any free license',
  commercial: 'OK for commercial use',
  'no-attribution': 'No credit needed'
}

export interface VisualLicense {
  // short name as the provider says it, e.g. "CC BY 2.0", "Pexels License", "Public domain"
  name: string
  url: string
  // the license asks you to credit the author
  attribution: boolean
  // the license allows use in a monetized video
  commercial: boolean
  // the license allows changes (crop, draw on, cut)
  modify: boolean
}

// one option found online. the urls are the provider's, main keeps them and fetches them itself
export interface VisualResult {
  // <provider>:<their id>
  id: string
  provider: ProviderId
  kind: VisualKind
  title: string
  author: string
  authorUrl: string
  // the page on the provider's site, for credit and for looking closer
  pageUrl: string
  // the file to download
  fileUrl: string
  // a small preview, main caches it and the ui shows it through td-media://visual
  thumbUrl: string
  // the cached copy of the thumbnail, a name for td-media://visual. empty when it didn't load
  thumb: string
  width: number | null
  height: number | null
  // seconds, video and audio
  duration: number | null
  // bytes when the provider says
  bytes: number | null
  // file extension without the dot, a guess from the url or mime when the provider doesn't say
  ext: string
  license: VisualLicense
  // the provider's own attribution line when it has one
  attribution: string
}

// where a file in the project folder came from, written next to it as <file>.credit.json
export interface VisualProvenance {
  version: 1
  // the file it belongs to, relative to the project folder
  file: string
  origin: 'search' | 'sketch' | 'paste' | 'link' | 'frame'
  provider: ProviderId | null
  title: string
  author: string
  authorUrl: string
  sourceUrl: string
  fileUrl: string
  license: VisualLicense | null
  attribution: string
  retrievedAt: string
  // e.g. "drawn on a frame from FilmCraft"
  note: string
}

// an image TrendDeck keeps for the chat: a sketch, something pasted or dropped, a downloaded option.
// lives in the user data folder, not the project, until you add it to the video files
export interface VisualAsset {
  id: string
  brandId: string
  origin: VisualProvenance['origin'] | 'search'
  name: string
  mime: string
  ext: string
  bytes: number
  width: number
  height: number
  createdAt: number
  // set for a downloaded search option or a dropped link
  source: VisualResult | null
  sourceUrl: string
  note: string
}

export interface VisualSearchInput {
  query: string
  kind: VisualKind
  orientation?: Orientation
  license?: LicenseFilter
  count?: number
  // only these, all that can search the kind when left out
  providers?: ProviderId[]
}

export interface ProviderNote {
  provider: ProviderId
  // ok, skipped (no key, can't search this kind), failed (with why, already plain)
  state: 'ok' | 'skipped' | 'failed'
  note: string
  count: number
}

export interface VisualSearch {
  id: string
  input: Required<Omit<VisualSearchInput, 'providers' | 'orientation'>> & { orientation: Orientation | null }
  results: VisualResult[]
  providers: ProviderNote[]
  at: number
}

// what the chat window learns about the provider keys: only whether they're saved
export interface MediaSourceKeys {
  pexels: boolean
  pixabay: boolean
  // safeStorage works on this computer, without it keys aren't kept
  canStore: boolean
}

export interface SaveImageInput {
  brandId: string
  threadId: string | null
  // data:image/png;base64,... or jpeg/webp/gif
  dataUrl: string
  origin: 'sketch' | 'paste' | 'frame'
  name?: string
  note?: string
}

export interface ToProjectResult {
  // relative to the project folder
  file: string
  credit: string
  note: string
}

export interface VisualsApi {
  search(brandId: string, threadId: string | null, input: VisualSearchInput): Promise<VisualSearch>
  asset(brandId: string, assetId: string): Promise<VisualAsset | null>
  saveImage(input: SaveImageInput): Promise<VisualAsset>
  // a search option downloaded into the chat's visuals (not the project) so it can be attached or drawn on
  fetchResult(brandId: string, resultId: string): Promise<VisualAsset>
  // an image or a page link dropped from a browser
  fetchLink(brandId: string, url: string): Promise<VisualAsset>
  // the file into <project>/media/visuals/ with its .credit.json
  resultToProject(brandId: string, projectId: string, resultId: string, threadId: string | null): Promise<ToProjectResult>
  assetToProject(brandId: string, projectId: string, assetId: string, threadId: string | null): Promise<ToProjectResult>
  // a pasted or dropped visual as a card in an open chat
  showCard(brandId: string, threadId: string, assetId: string): Promise<string>
  keys(): Promise<MediaSourceKeys>
  setKey(provider: 'pexels' | 'pixabay', key: string): Promise<MediaSourceKeys>
  clearKey(provider: 'pexels' | 'pixabay'): Promise<MediaSourceKeys>
}

declare global {
  interface Window {
    trenddeckVisuals: VisualsApi
  }
}

// ---- pure helpers, unit tested ----

export const isVisualKind = (v: unknown): v is VisualKind => (VISUAL_KINDS as readonly unknown[]).includes(v)
export const isProvider = (v: unknown): v is ProviderId => (PROVIDERS as readonly unknown[]).includes(v)

// td-media://visual/<brand>/<name> for a cached thumbnail (thumbs/...) or an asset (items/...)
export function visualUrl(brandId: string, name: string): string {
  return `td-media://visual/${brandId}/${name.split('/').map(encodeURIComponent).join('/')}`
}

export const assetUrl = (a: Pick<VisualAsset, 'brandId' | 'id' | 'ext'>): string => visualUrl(a.brandId, `items/${a.id}.${a.ext}`)

export function fileSizeText(n: number | null): string {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1000) return `${Math.round(n / 1000)} KB`
  return `${n} B`
}

export function durationText(s: number | null): string {
  if (s === null || !Number.isFinite(s) || s <= 0) return ''
  const t = Math.round(s)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// one line for a result in the grid or for the agent: size, length and kind
export function resultSize(r: Pick<VisualResult, 'width' | 'height' | 'duration' | 'bytes'>): string {
  const parts: string[] = []
  if (r.width && r.height) parts.push(`${r.width} by ${r.height}`)
  const d = durationText(r.duration)
  if (d) parts.push(d)
  const b = fileSizeText(r.bytes)
  if (b) parts.push(b)
  return parts.join(', ')
}

// the credit line to paste in a description, the way CC asks for it: title, author, source, license
export function creditLine(p: Pick<VisualProvenance, 'title' | 'author' | 'sourceUrl' | 'license' | 'provider' | 'attribution' | 'origin'>): string {
  if (p.origin !== 'search' && p.origin !== 'link') return ''
  if (p.attribution.trim()) return p.attribution.trim().replace(/\s+/g, ' ')
  const parts = [p.title ? `"${p.title}"` : 'Untitled']
  if (p.author) parts.push(`by ${p.author}`)
  if (p.provider) parts.push(`from ${PROVIDER_NAMES[p.provider]}`)
  if (p.sourceUrl) parts.push(`(${p.sourceUrl})`)
  if (p.license?.name) parts.push(`, ${p.license.name}${p.license.url ? ` ${p.license.url}` : ''}`)
  return parts.join(' ').replace(' ,', ',')
}

export function matchesLicense(l: VisualLicense, filter: LicenseFilter): boolean {
  if (filter === 'commercial') return l.commercial
  if (filter === 'no-attribution') return !l.attribution && l.commercial
  return true
}

export function matchesOrientation(w: number | null, h: number | null, o: Orientation | null): boolean {
  if (!o || !w || !h) return true
  const r = w / h
  if (o === 'square') return r > 0.9 && r < 1.1
  return o === 'landscape' ? r >= 1.1 : r <= 0.9
}

// a Creative Commons or public domain license from its short name or url
export function ccLicense(code: string, version = '', url = ''): VisualLicense {
  const c = code.toLowerCase().replace(/^cc[\s-]?/, '').replace(/\s+/g, '-').trim()
  if (c === '0' || c === 'zero' || c === 'cc0' || /publicdomain\/zero/.test(url)) {
    return { name: 'CC0', url: url || 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: false, commercial: true, modify: true }
  }
  if (c === 'pdm' || c === 'pd' || /public[-\s]?domain/.test(c) || /publicdomain\/mark/.test(url)) {
    return { name: 'Public domain', url: url || 'https://creativecommons.org/publicdomain/mark/1.0/', attribution: false, commercial: true, modify: true }
  }
  const parts = c.split('-').filter(Boolean)
  if (!parts.includes('by')) {
    return { name: code || 'Unknown license', url, attribution: true, commercial: false, modify: false }
  }
  const nc = parts.includes('nc')
  const nd = parts.includes('nd')
  const name = `CC ${parts.filter((p) => !/^\d/.test(p)).map((p) => p.toUpperCase()).join('-')}${version ? ` ${version}` : ''}`
  const fallback = `https://creativecommons.org/licenses/${parts.filter((p) => !/^\d/.test(p)).join('-')}/${version || '4.0'}/`
  return { name, url: url || fallback, attribution: true, commercial: !nc, modify: !nd }
}

// file names for the project folder: plain, short, no path bits
export function visualFileStem(title: string, fallback = 'visual'): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/^file:/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return s || fallback
}
