import {
  ccLicense,
  matchesLicense,
  matchesOrientation,
  type LicenseFilter,
  type Orientation,
  type ProviderId,
  type VisualKind,
  type VisualLicense,
  type VisualResult
} from '@shared/visuals'

// what each provider's search api wants and how its answer becomes VisualResults. pure, no
// electron and no network, so the tests can feed it fixture shapes. keys go in through `key`
// and only ever into the request, never into a result

export interface SearchQuery {
  query: string
  kind: VisualKind
  orientation: Orientation | null
  license: LicenseFilter
  count: number
}

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
}

const PEXELS_LICENSE: VisualLicense = { name: 'Pexels License', url: 'https://www.pexels.com/license/', attribution: false, commercial: true, modify: true }
const PIXABAY_LICENSE: VisualLicense = {
  name: 'Pixabay Content License',
  url: 'https://pixabay.com/service/license-summary/',
  attribution: false,
  commercial: true,
  modify: true
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

// only links a browser could open, nothing local
export function webUrl(v: unknown): string {
  const s = str(v, 2000)
  if (!s) return ''
  try {
    const u = new URL(s.startsWith('//') ? `https:${s}` : s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''
  } catch {
    return ''
  }
}

export function extOf(url: string, mime = ''): string {
  const m = /^(?:image|video|audio)\/([a-z0-9.+-]+)/i.exec(mime)
  if (m) {
    const t = m[1].toLowerCase()
    return t === 'jpeg' ? 'jpg' : t === 'svg+xml' ? 'svg' : t === 'quicktime' ? 'mov' : t === 'mpeg' ? 'mp3' : t.replace(/^x-/, '')
  }
  try {
    const e = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''
    return e === 'jpeg' ? 'jpg' : e
  } catch {
    return ''
  }
}

// html in Wikimedia's metadata, as plain text
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function finish(list: VisualResult[], q: SearchQuery): VisualResult[] {
  const seen = new Set<string>()
  return list.filter((r) => {
    if (!r.fileUrl || !r.pageUrl || seen.has(r.id)) return false
    seen.add(r.id)
    return matchesLicense(r.license, q.license) && matchesOrientation(r.width, r.height, q.orientation)
  })
}

// ---------- Openverse, no key ----------

export function openverseRequest(q: SearchQuery): ProviderRequest | null {
  if (q.kind === 'video') return null
  const p = new URLSearchParams({ q: q.query, page_size: String(Math.min(20, Math.max(q.count, 1) + 4)), mature: 'false' })
  if (q.license === 'commercial') p.set('license_type', 'commercial')
  if (q.license === 'no-attribution') p.set('license', 'cc0,pdm')
  if (q.kind === 'gif') p.set('extension', 'gif')
  if (q.kind !== 'audio' && q.orientation) p.set('aspect_ratio', q.orientation === 'landscape' ? 'wide' : q.orientation === 'portrait' ? 'tall' : 'square')
  return { url: `https://api.openverse.org/v1/${q.kind === 'audio' ? 'audio' : 'images'}/?${p}`, headers: {} }
}

export function parseOpenverse(body: unknown, q: SearchQuery): VisualResult[] {
  const out: VisualResult[] = []
  for (const raw of arr(rec(body).results)) {
    const r = rec(raw)
    const id = str(r.id, 100)
    const fileUrl = webUrl(r.url)
    if (!id || !fileUrl) continue
    const license = ccLicense(str(r.license, 40), str(r.license_version, 10), webUrl(r.license_url))
    const ext = str(r.filetype, 10).toLowerCase() || extOf(fileUrl)
    if (q.kind === 'gif' && ext !== 'gif') continue
    out.push({
      id: `openverse:${id}`,
      provider: 'openverse',
      kind: q.kind,
      title: str(r.title, 200) || 'Untitled',
      author: str(r.creator, 200),
      authorUrl: webUrl(r.creator_url),
      pageUrl: webUrl(r.foreign_landing_url) || `https://openverse.org/${q.kind === 'audio' ? 'audio' : 'image'}/${encodeURIComponent(id)}`,
      fileUrl,
      thumbUrl: webUrl(r.thumbnail) || (q.kind === 'audio' ? '' : fileUrl),
      thumb: '',
      width: num(r.width),
      height: num(r.height),
      duration: q.kind === 'audio' && num(r.duration) ? Math.round(num(r.duration)! / 1000) : null,
      bytes: num(r.filesize),
      ext: ext === 'jpeg' ? 'jpg' : ext,
      license,
      attribution: str(r.attribution, 600)
    })
  }
  return finish(out, q)
}

// ---------- Wikimedia Commons, no key ----------

export function wikimediaRequest(q: SearchQuery): ProviderRequest {
  const filter = q.kind === 'gif' ? 'filemime:image/gif' : q.kind === 'image' ? 'filetype:bitmap' : q.kind === 'video' ? 'filetype:video' : 'filetype:audio'
  const p = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${q.query} ${filter}`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(30, Math.max(q.count, 1) * 2)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|user',
    iiurlwidth: '480',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|AttributionRequired|UsageTerms|ObjectName|Credit|NonFree'
  })
  return { url: `https://commons.wikimedia.org/w/api.php?${p}`, headers: {} }
}

function wikiLicense(meta: Record<string, unknown>): VisualLicense {
  const val = (k: string): string => plainText(str(rec(meta[k]).value, 400))
  const short = val('LicenseShortName')
  const url = webUrl(val('LicenseUrl'))
  const nonFree = val('NonFree').toLowerCase() === 'true'
  const attrReq = val('AttributionRequired').toLowerCase()
  const lower = short.toLowerCase()
  let lic: VisualLicense
  if (/public domain|^pd\b|pd-/.test(lower)) lic = ccLicense('pdm', '', url)
  else if (/cc0/.test(lower)) lic = ccLicense('cc0', '', url)
  else if (/^cc[ -]/.test(lower)) {
    const m = /^cc[ -]([a-z-]+)(?:[ -]([\d.]+))?(?:[ -].*)?$/i.exec(short)
    lic = ccLicense(m?.[1] ?? short, m?.[2] ?? '', url)
  } else {
    // GFDL, free art license, attribution only and so on: free to use with credit
    lic = { name: short || 'See the file page', url, attribution: attrReq !== 'false', commercial: !nonFree, modify: !nonFree }
  }
  if (attrReq === 'false') lic.attribution = false
  if (attrReq === 'true') lic.attribution = true
  if (nonFree) lic.commercial = false
  return lic
}

export function parseWikimedia(body: unknown, q: SearchQuery): VisualResult[] {
  const pages = arr(rec(rec(body).query).pages)
    .map(rec)
    .sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0))
  const out: VisualResult[] = []
  for (const page of pages) {
    const info = rec(arr(page.imageinfo)[0])
    const fileUrl = webUrl(info.url)
    const mime = str(info.mime, 80).toLowerCase()
    if (!fileUrl) continue
    if (q.kind === 'image' && (!mime.startsWith('image/') || mime === 'image/gif' || mime === 'image/svg+xml')) continue
    if (q.kind === 'gif' && mime !== 'image/gif') continue
    if (q.kind === 'video' && !mime.startsWith('video/') && mime !== 'application/ogg') continue
    if (q.kind === 'audio' && !mime.startsWith('audio/')) continue
    const meta = rec(info.extmetadata)
    const val = (k: string): string => plainText(str(rec(meta[k]).value, 600))
    const title = (val('ObjectName') || str(page.title, 200).replace(/^File:/, '').replace(/\.[a-z0-9]{2,5}$/i, '')).slice(0, 200)
    const author = (val('Artist') || str(info.user, 120)).slice(0, 200)
    const license = wikiLicense(meta)
    const pageUrl = webUrl(info.descriptionurl) || `https://commons.wikimedia.org/wiki/${encodeURIComponent(str(page.title, 300).replace(/ /g, '_'))}`
    out.push({
      id: `wikimedia:${num(page.pageid) ?? str(page.title, 200)}`,
      provider: 'wikimedia',
      kind: q.kind,
      title,
      author,
      authorUrl: '',
      pageUrl,
      fileUrl,
      thumbUrl: q.kind === 'audio' ? '' : webUrl(info.thumburl),
      thumb: '',
      width: num(info.width),
      height: num(info.height),
      duration: num(info.duration),
      bytes: num(info.size),
      ext: extOf(fileUrl, mime),
      license,
      attribution: license.attribution ? `${title}${author ? ` by ${author}` : ''}, ${license.name}${license.url ? ` (${license.url})` : ''}, via Wikimedia Commons (${pageUrl})` : ''
    })
  }
  return finish(out, q)
}

// ---------- Pexels, free key ----------

export function pexelsRequest(q: SearchQuery, key: string): ProviderRequest | null {
  if (!key || (q.kind !== 'image' && q.kind !== 'video')) return null
  const p = new URLSearchParams({ query: q.query, per_page: String(Math.min(40, Math.max(q.count, 1) + 4)) })
  if (q.orientation) p.set('orientation', q.orientation)
  const base = q.kind === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search'
  return { url: `${base}?${p}`, headers: { Authorization: key } }
}

export function parsePexels(body: unknown, q: SearchQuery): VisualResult[] {
  const out: VisualResult[] = []
  const b = rec(body)
  if (q.kind === 'video') {
    for (const raw of arr(b.videos)) {
      const v = rec(raw)
      const id = num(v.id)
      // the biggest file up to 1080p, a 4k master is rarely what a short needs
      const files = arr(v.video_files)
        .map(rec)
        .filter((f) => webUrl(f.link) && /video\/mp4/i.test(str(f.file_type, 40)))
        .sort((a, b2) => (num(b2.height) ?? 0) - (num(a.height) ?? 0))
      const pick = files.find((f) => Math.min(num(f.height) ?? 0, num(f.width) ?? 0) <= 1080) ?? files[files.length - 1]
      if (!id || !pick) continue
      const user = rec(v.user)
      out.push({
        id: `pexels:v${id}`,
        provider: 'pexels',
        kind: 'video',
        title: titleFromSlug(str(v.url, 400)) || 'Pexels video',
        author: str(user.name, 200),
        authorUrl: webUrl(user.url),
        pageUrl: webUrl(v.url),
        fileUrl: webUrl(pick.link),
        thumbUrl: webUrl(v.image),
        thumb: '',
        width: num(pick.width) ?? num(v.width),
        height: num(pick.height) ?? num(v.height),
        duration: num(v.duration),
        bytes: null,
        ext: 'mp4',
        license: PEXELS_LICENSE,
        attribution: ''
      })
    }
  } else {
    for (const raw of arr(b.photos)) {
      const p = rec(raw)
      const id = num(p.id)
      const src = rec(p.src)
      const fileUrl = webUrl(src.original) || webUrl(src.large2x)
      if (!id || !fileUrl) continue
      out.push({
        id: `pexels:${id}`,
        provider: 'pexels',
        kind: 'image',
        title: str(p.alt, 200) || titleFromSlug(str(p.url, 400)) || 'Pexels photo',
        author: str(p.photographer, 200),
        authorUrl: webUrl(p.photographer_url),
        pageUrl: webUrl(p.url),
        fileUrl,
        thumbUrl: webUrl(src.medium) || webUrl(src.small) || webUrl(src.tiny),
        thumb: '',
        width: num(p.width),
        height: num(p.height),
        duration: null,
        bytes: null,
        ext: extOf(fileUrl) || 'jpg',
        license: PEXELS_LICENSE,
        attribution: ''
      })
    }
  }
  return finish(out, q)
}

// "https://www.pexels.com/photo/red-fox-in-snow-12345/" -> "Red fox in snow"
export function titleFromSlug(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const words = seg.replace(/-?\d+$/, '').split('-').filter(Boolean).join(' ')
    return words ? words[0].toUpperCase() + words.slice(1) : ''
  } catch {
    return ''
  }
}

// ---------- Pixabay, free key ----------

export function pixabayRequest(q: SearchQuery, key: string): ProviderRequest | null {
  if (!key || (q.kind !== 'image' && q.kind !== 'video')) return null
  const p = new URLSearchParams({ key, q: q.query.slice(0, 100), per_page: String(Math.min(50, Math.max(q.count, 3) + 4)), safesearch: 'true' })
  if (q.orientation === 'landscape') p.set('orientation', 'horizontal')
  if (q.orientation === 'portrait') p.set('orientation', 'vertical')
  if (q.kind === 'image') p.set('image_type', 'photo')
  return { url: `https://pixabay.com/api/${q.kind === 'video' ? 'videos/' : ''}?${p}`, headers: {} }
}

export function parsePixabay(body: unknown, q: SearchQuery): VisualResult[] {
  const out: VisualResult[] = []
  for (const raw of arr(rec(body).hits)) {
    const h = rec(raw)
    const id = num(h.id)
    if (!id) continue
    const tags = str(h.tags, 200)
    const title = tags ? tags.split(',')[0].trim().replace(/^./, (c) => c.toUpperCase()) : 'Pixabay'
    const base = { provider: 'pixabay' as const, author: str(h.user, 200), authorUrl: h.user_id ? `https://pixabay.com/users/${encodeURIComponent(str(h.user, 100))}-${num(h.user_id)}/` : '', pageUrl: webUrl(h.pageURL), license: PIXABAY_LICENSE, attribution: '' }
    if (q.kind === 'video') {
      const vids = rec(h.videos)
      const pick = ['large', 'medium', 'small', 'tiny'].map((k) => rec(vids[k])).find((v) => webUrl(v.url) && (num(v.height) ?? 0) <= 1080 && (num(v.size) ?? 1) > 0)
      if (!pick) continue
      out.push({
        ...base,
        id: `pixabay:v${id}`,
        kind: 'video',
        title,
        fileUrl: webUrl(pick.url),
        thumbUrl: webUrl(pick.thumbnail) || webUrl(rec(vids.tiny).thumbnail),
        thumb: '',
        width: num(pick.width),
        height: num(pick.height),
        duration: num(h.duration),
        bytes: num(pick.size),
        ext: 'mp4'
      })
    } else {
      const fileUrl = webUrl(h.largeImageURL) || webUrl(h.webformatURL)
      if (!fileUrl) continue
      out.push({
        ...base,
        id: `pixabay:${id}`,
        kind: 'image',
        title,
        fileUrl,
        thumbUrl: webUrl(h.webformatURL) || webUrl(h.previewURL),
        thumb: '',
        width: num(h.imageWidth),
        height: num(h.imageHeight),
        duration: null,
        bytes: num(h.imageSize),
        ext: extOf(fileUrl) || 'jpg'
      })
    }
  }
  return finish(out, q)
}

export const REQUESTS: Record<ProviderId, (q: SearchQuery, key: string) => ProviderRequest | null> = {
  openverse: (q) => openverseRequest(q),
  wikimedia: (q) => wikimediaRequest(q),
  pexels: pexelsRequest,
  pixabay: pixabayRequest
}

export const PARSERS: Record<ProviderId, (body: unknown, q: SearchQuery) => VisualResult[]> = {
  openverse: parseOpenverse,
  wikimedia: parseWikimedia,
  pexels: parsePexels,
  pixabay: parsePixabay
}

// takes turns between providers so one with many hits doesn't fill the grid
export function interleave(lists: VisualResult[][], count: number): VisualResult[] {
  const out: VisualResult[] = []
  for (let i = 0; out.length < count && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < count) out.push(l[i])
  }
  return out
}

// what a failed request says to the user, without the url (Pixabay's key rides in it)
export function providerError(status: number, provider: ProviderId): string {
  if (status === 401 || status === 403) return provider === 'pexels' || provider === 'pixabay' ? 'The key was refused. Check it in Settings, Media sources.' : 'The service refused the request.'
  if (status === 429) return 'Too many searches for now. Try again in a minute.'
  if (status >= 500) return 'The service is having trouble. Try again later.'
  return `The search failed (HTTP ${status}).`
}
