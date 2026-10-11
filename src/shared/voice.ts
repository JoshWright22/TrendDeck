// brand voice: the profile, past posts and the context pack the chat puts in front of a prompt.
// everything here is plain code, nothing calls an agent

export const VOICE_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x', 'reddit', 'other'] as const
export type VoicePlatform = (typeof VOICE_PLATFORMS)[number]
// the ones "import from my accounts" knows how to read
export const IMPORT_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x', 'reddit'] as const
export type ImportPlatform = (typeof IMPORT_PLATFORMS)[number]

export const PLATFORM_NAMES: Record<VoicePlatform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  x: 'X',
  reddit: 'Reddit',
  other: 'Other'
}

export interface VoicePost {
  id: string
  platform: VoicePlatform
  // ms, null when we don't know
  postedAt: number | null
  text: string
  url: string
  views: number | null
  likes: number | null
  starred: boolean
  tags: string[]
  addedAt: number
  source: 'paste' | 'file' | 'import'
}

export interface VoiceProfile {
  about: string
  audience: string
  tone: string[]
  topics: string[]
  never: string
  useWords: string[]
  avoidWords: string[]
  useEmoji: string[]
  avoidEmoji: string[]
  ctas: string[]
  links: string[]
  hashtags: string[]
  // the brand's own handle on each site, used by the importer
  handles: Partial<Record<ImportPlatform, string>>
  platformNotes: Partial<Record<VoicePlatform, string>>
}

export interface VoiceParts {
  profile: boolean
  summary: boolean
  examples: boolean
}

export interface VoiceData {
  version: 1
  profile: VoiceProfile
  posts: VoicePost[]
  // null means use the computed summary, text means the user edited it
  summaryText: string | null
  parts: VoiceParts
  budget: number
}

export interface VoiceImportResult {
  platform: ImportPlatform
  found: number
  added: number
  error?: string
}

export interface VoiceApi {
  voiceLoad(brandId: string): Promise<VoiceData>
  voiceSave(brandId: string, data: VoiceData): Promise<void>
  // reads the brand's own recent posts from its logged in sessions, only when asked
  voiceImport(
    brandId: string,
    platforms: ImportPlatform[]
  ): Promise<{ data: VoiceData; results: VoiceImportResult[] }>
}

export const MAX_POSTS = 2000
export const MAX_POST_CHARS = 5000
export const DEFAULT_BUDGET = 6000

export function emptyProfile(): VoiceProfile {
  return {
    about: '',
    audience: '',
    tone: [],
    topics: [],
    never: '',
    useWords: [],
    avoidWords: [],
    useEmoji: [],
    avoidEmoji: [],
    ctas: [],
    links: [],
    hashtags: [],
    handles: {},
    platformNotes: {}
  }
}

export function emptyVoice(): VoiceData {
  return {
    version: 1,
    profile: emptyProfile(),
    posts: [],
    summaryText: null,
    parts: { profile: true, summary: true, examples: true },
    budget: DEFAULT_BUDGET
  }
}

// cleaning, used on load, save and anything coming from a file or a page

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.slice(0, max) : ''
}

function list(raw: unknown, max: number, count = 60): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim().slice(0, max)
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
    if (out.length >= count) break
  }
  return out
}

function num(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

export function isPlatform(p: unknown): p is VoicePlatform {
  return (VOICE_PLATFORMS as readonly unknown[]).includes(p)
}

export function cleanPost(raw: unknown): VoicePost | null {
  const p = raw as Partial<VoicePost> | null
  if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id)) return null
  const text = str(p.text, MAX_POST_CHARS).trim()
  if (!text) return null
  const url = str(p.url, 2000)
  return {
    id: p.id,
    platform: isPlatform(p.platform) ? p.platform : 'other',
    postedAt: num(p.postedAt),
    text,
    url: /^https?:\/\//i.test(url) ? url : '',
    views: num(p.views),
    likes: num(p.likes),
    starred: p.starred === true,
    tags: list(p.tags, 40, 20),
    addedAt: num(p.addedAt) ?? 0,
    source: p.source === 'file' || p.source === 'import' ? p.source : 'paste'
  }
}

export function cleanVoice(raw: unknown): VoiceData {
  const d = (raw ?? {}) as Partial<VoiceData>
  const p = (d.profile ?? {}) as Partial<VoiceProfile>
  const handles: VoiceProfile['handles'] = {}
  const rawHandles = (p.handles ?? {}) as Record<string, unknown>
  for (const k of IMPORT_PLATFORMS) {
    const h = cleanHandle(str(rawHandles[k], 200))
    if (h) handles[k] = h
  }
  const platformNotes: VoiceProfile['platformNotes'] = {}
  const rawNotes = (p.platformNotes ?? {}) as Record<string, unknown>
  for (const k of VOICE_PLATFORMS) {
    const n = str(rawNotes[k], 2000)
    if (n.trim()) platformNotes[k] = n
  }
  const profile: VoiceProfile = {
    about: str(p.about, 3000),
    audience: str(p.audience, 2000),
    tone: list(p.tone, 40),
    topics: list(p.topics, 80),
    never: str(p.never, 2000),
    useWords: list(p.useWords, 60),
    avoidWords: list(p.avoidWords, 60),
    useEmoji: list(p.useEmoji, 16),
    avoidEmoji: list(p.avoidEmoji, 16),
    ctas: list(p.ctas, 200, 20),
    links: list(p.links, 300, 20),
    hashtags: list(p.hashtags, 60).map((h) => (h.startsWith('#') ? h : `#${h}`)),
    handles,
    platformNotes
  }
  const seen = new Set<string>()
  const posts: VoicePost[] = []
  for (const r of Array.isArray(d.posts) ? d.posts : []) {
    const post = cleanPost(r)
    if (!post || seen.has(post.id)) continue
    seen.add(post.id)
    posts.push(post)
    if (posts.length >= MAX_POSTS) break
  }
  const parts = (d.parts ?? {}) as Partial<VoiceParts>
  const budget = Number(d.budget)
  return {
    version: 1,
    profile,
    posts,
    summaryText: typeof d.summaryText === 'string' ? d.summaryText.slice(0, 8000) : null,
    parts: {
      profile: parts.profile !== false,
      summary: parts.summary !== false,
      examples: parts.examples !== false
    },
    budget: Number.isFinite(budget) ? Math.min(40000, Math.max(500, Math.round(budget))) : DEFAULT_BUDGET
  }
}

// "@name", "https://x.com/name" or "u/name" all end up as name
export function cleanHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^(u|user)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 60)
}

// same post twice: same url, or same platform and text
export function postKey(p: Pick<VoicePost, 'platform' | 'text' | 'url'>): string {
  // keep the query, youtube's video id lives in it
  return p.url ? `u:${p.url.replace(/#.*$/, '').replace(/\/$/, '')}` : `t:${p.platform}:${p.text.slice(0, 200)}`
}

// adds new posts, and refreshes views and likes on ones we already have
export function mergePosts(have: VoicePost[], fresh: VoicePost[]): { posts: VoicePost[]; added: number } {
  const byKey = new Map(have.map((p, i) => [postKey(p), i]))
  const posts = [...have]
  let added = 0
  for (const f of fresh) {
    const i = byKey.get(postKey(f))
    if (i !== undefined) {
      const old = posts[i]
      posts[i] = {
        ...old,
        views: f.views ?? old.views,
        likes: f.likes ?? old.likes,
        postedAt: old.postedAt ?? f.postedAt
      }
      continue
    }
    if (posts.length >= MAX_POSTS) break
    byKey.set(postKey(f), posts.length)
    posts.push(f)
    added++
  }
  return { posts, added }
}

// numbers the way sites show them: "1.2K", "3,400", "1.1M views"
export function parseCount(raw: unknown): number | null {
  if (typeof raw === 'number') return num(raw)
  if (typeof raw !== 'string') return null
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i)
  if (!m) return null
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1
  return Math.round(Number(m[1]) * mult)
}

export function parseDate(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // seconds or ms
    return raw < 1e11 ? raw * 1000 : raw
  }
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  if (/^\d{9,13}$/.test(s)) return parseDate(Number(s))
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

// file import: txt, csv or json, the platform picked in the ui is used when the file has none

export interface FilePost {
  platform: VoicePlatform
  postedAt: number | null
  text: string
  url: string
  views: number | null
  likes: number | null
}

const TEXT_KEYS = ['text', 'full_text', 'content', 'caption', 'body', 'description', 'message', 'post', 'tweet', 'title']
const DATE_KEYS = ['postedat', 'posted_at', 'date', 'posted', 'created_at', 'created', 'createtime', 'timestamp', 'time', 'published', 'published_at']
const VIEW_KEYS = ['views', 'view_count', 'viewcount', 'plays', 'playcount', 'impressions']
const LIKE_KEYS = ['likes', 'like_count', 'likecount', 'favorite_count', 'favorites', 'diggcount', 'score', 'upvotes']
const URL_KEYS = ['url', 'link', 'permalink', 'href']

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), obj[k]]))
  for (const k of keys) if (lower.has(k) && lower.get(k) !== '' && lower.get(k) != null) return lower.get(k)
  return undefined
}

function platformOf(raw: unknown, fallback: VoicePlatform): VoicePlatform {
  if (typeof raw !== 'string') return fallback
  const s = raw.toLowerCase().trim()
  if (isPlatform(s)) return s
  if (s.includes('youtube')) return 'youtube'
  if (s.includes('tiktok')) return 'tiktok'
  if (s.includes('insta')) return 'instagram'
  if (s.includes('twitter') || s === 'x.com') return 'x'
  if (s.includes('reddit')) return 'reddit'
  return fallback
}

function fromObject(o: Record<string, unknown>, fallback: VoicePlatform): FilePost | null {
  // x archives wrap each one as { tweet: {...} }
  if (o.tweet && typeof o.tweet === 'object') return fromObject(o.tweet as Record<string, unknown>, 'x')
  let text = pick(o, TEXT_KEYS)
  // reddit style: title plus body
  const title = pick(o, ['title'])
  const body = pick(o, ['selftext', 'body', 'text'])
  if (typeof title === 'string' && typeof body === 'string' && body.trim() && title !== body) {
    text = `${title}\n\n${body}`
  }
  if (typeof text !== 'string' || !text.trim()) return null
  const url = pick(o, URL_KEYS)
  return {
    platform: platformOf(pick(o, ['platform', 'site', 'network', 'source']), fallback),
    postedAt: parseDate(pick(o, DATE_KEYS)),
    text: text.trim().slice(0, MAX_POST_CHARS),
    url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '',
    views: parseCount(pick(o, VIEW_KEYS)),
    likes: parseCount(pick(o, LIKE_KEYS))
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
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
  return rows.filter((r) => r.some((c) => c.trim()))
}

// plain text: posts split by a blank line or a line of ---
export function splitText(text: string): string[] {
  const byRule = text.split(/\r?\n\s*-{3,}\s*\r?\n/)
  const chunks = byRule.length > 1 ? byRule : text.split(/\r?\n\s*\r?\n/)
  return chunks.map((c) => c.trim()).filter(Boolean)
}

export function parseFile(name: string, content: string, fallback: VoicePlatform): FilePost[] {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const trimmed = content.replace(/^﻿/, '').trim()
  if (ext === 'json' || ext === 'js' || /^[[{]/.test(trimmed)) {
    // x archive files start with "window.YTD.tweets.part0 = "
    const json = trimmed.replace(/^window\.[\w.]+\s*=\s*/, '')
    let data: unknown
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error("that file isn't valid json")
    }
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as { posts?: unknown }).posts)
        ? (data as { posts: unknown[] }).posts
        : [data]
    return arr
      .map((o) => (o && typeof o === 'object' ? fromObject(o as Record<string, unknown>, fallback) : null))
      .filter((p): p is FilePost => p !== null)
  }
  if (ext === 'csv') {
    const rows = parseCsv(trimmed)
    if (rows.length < 2) return []
    const head = rows[0].map((h) => h.trim())
    return rows
      .slice(1)
      .map((r) => fromObject(Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])), fallback))
      .filter((p): p is FilePost => p !== null)
  }
  return splitText(trimmed).map((t) => ({
    platform: fallback,
    postedAt: null,
    text: t.slice(0, MAX_POST_CHARS),
    url: '',
    views: null,
    likes: null
  }))
}

// local analysis, no agent

const STOP = new Set(
  `a an the and or but if so of to in on at for with from by as is are was were be been being it its it's
  this that these those i im i'm me my we our you your he she they them their his her what which who whom
  do does did doing have has had having not no yes just than then there here when where why how all any
  can could will would should may might must about into over under up down out off again more most some such
  only own same too very s t don't dont can't cant won't wont get got go going one two also like really
  am us let's lets via de la el en le et x y`.split(/\s+/)
)

const URL_RE = /https?:\/\/\S+/g
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu
const TAG_RE = /#[\p{L}\p{N}_]+/gu

function words(text: string): string[] {
  return (
    text
      .replace(URL_RE, ' ')
      .replace(TAG_RE, ' ')
      .replace(/@[\w.]+/g, ' ')
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? []
  )
}

function counts(items: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return m
}

function top(m: Map<string, number>, n: number, min = 1): [string, number][] {
  return [...m.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
}

export interface PlatformStats {
  platform: VoicePlatform | 'all'
  posts: number
  avgChars: number
  avgWords: number
  avgLines: number
  emojiPerPost: number
  hashtagsPerPost: number
  // share of posts, 0 to 1
  questions: number
  withLinks: number
  openers: [string, number][]
  closers: [string, number][]
  emoji: [string, number][]
  hashtags: [string, number][]
  words: [string, number][]
}

export interface VoiceSummary {
  total: number
  all: PlatformStats
  platforms: PlatformStats[]
  // post ids, best first
  best: string[]
}

const round1 = (n: number): number => Math.round(n * 10) / 10

function stats(platform: PlatformStats['platform'], posts: VoicePost[]): PlatformStats {
  const n = posts.length || 1
  const allWords: string[] = []
  const emoji: string[] = []
  const tags: string[] = []
  const openers: string[] = []
  const closers: string[] = []
  let chars = 0
  let wordCount = 0
  let lines = 0
  let questions = 0
  let links = 0
  for (const p of posts) {
    const w = words(p.text)
    chars += p.text.length
    wordCount += w.length
    lines += p.text.split(/\n+/).filter((l) => l.trim()).length
    if (p.text.includes('?')) questions++
    if (URL_RE.test(p.text)) links++
    URL_RE.lastIndex = 0
    allWords.push(...w.filter((x) => x.length > 2 && !STOP.has(x) && !/^\d+$/.test(x)))
    emoji.push(...(p.text.match(EMOJI_RE) ?? []))
    tags.push(...(p.text.match(TAG_RE) ?? []).map((t) => t.toLowerCase()))
    if (w.length >= 4) {
      openers.push(w.slice(0, 3).join(' '))
      closers.push(w.slice(-3).join(' '))
    }
    // a short last line is usually a sign-off or call to action
    const last = p.text.trim().split(/\n/).pop()?.trim() ?? ''
    if (last && last.length <= 60 && p.text.includes('\n')) closers.push(last.toLowerCase())
  }
  const min = posts.length >= 6 ? 2 : 1
  return {
    platform,
    posts: posts.length,
    avgChars: Math.round(chars / n),
    avgWords: Math.round(wordCount / n),
    avgLines: round1(lines / n),
    emojiPerPost: round1(emoji.length / n),
    hashtagsPerPost: round1(tags.length / n),
    questions: questions / n,
    withLinks: links / n,
    openers: top(counts(openers), 5, Math.max(2, min)),
    closers: top(counts(closers), 5, Math.max(2, min)),
    emoji: top(counts(emoji), 10),
    hashtags: top(counts(tags), 10, min),
    words: top(counts(allWords), 20, min)
  }
}

// 0 to 1 within the post's own platform, views first, likes if no views
export function performance(posts: VoicePost[]): Map<string, number> {
  const out = new Map<string, number>()
  const byPlatform = new Map<VoicePlatform, VoicePost[]>()
  for (const p of posts) byPlatform.set(p.platform, [...(byPlatform.get(p.platform) ?? []), p])
  for (const group of byPlatform.values()) {
    for (const metric of ['views', 'likes'] as const) {
      const have = group.filter((p) => p[metric] !== null && !out.has(p.id))
      if (have.length < 2) continue
      const sorted = [...have].sort((a, b) => (a[metric] as number) - (b[metric] as number))
      sorted.forEach((p, i) => out.set(p.id, i / (sorted.length - 1)))
    }
  }
  return out
}

export function analyze(posts: VoicePost[]): VoiceSummary {
  const platforms = VOICE_PLATFORMS.map((p) => posts.filter((x) => x.platform === p))
    .filter((g) => g.length > 0)
    .map((g) => stats(g[0].platform, g))
  const perf = performance(posts)
  const best = [...perf.entries()]
    .filter(([, s]) => s >= 0.75)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id)
  return { total: posts.length, all: stats('all', posts), platforms, best }
}

const pct = (n: number): string => `${Math.round(n * 100)}%`
const joinTop = (xs: [string, number][]): string => xs.map(([s, c]) => (c > 1 ? `${s} (${c})` : s)).join(', ')

function statsLines(s: PlatformStats): string[] {
  const name = s.platform === 'all' ? 'All posts' : PLATFORM_NAMES[s.platform]
  const out = [
    `${name}: ${s.posts} posts, about ${s.avgWords} words (${s.avgChars} characters) and ${s.avgLines} lines each.`,
    `  ${s.emojiPerPost} emoji and ${s.hashtagsPerPost} hashtags per post, ${pct(s.questions)} ask a question, ${pct(s.withLinks)} have a link.`
  ]
  if (s.openers.length) out.push(`  Often starts with: ${joinTop(s.openers)}`)
  if (s.closers.length) out.push(`  Often ends with: ${joinTop(s.closers)}`)
  if (s.emoji.length) out.push(`  Emoji used: ${joinTop(s.emoji)}`)
  if (s.hashtags.length) out.push(`  Hashtags used: ${joinTop(s.hashtags)}`)
  if (s.words.length) out.push(`  Most used words: ${joinTop(s.words.slice(0, 12))}`)
  return out
}

export function summaryText(summary: VoiceSummary, posts: VoicePost[], platform?: VoicePlatform): string {
  if (summary.total === 0) return ''
  const groups = platform ? summary.platforms.filter((s) => s.platform === platform) : summary.platforms
  const out: string[] = []
  if (!platform && summary.platforms.length > 1) out.push(...statsLines(summary.all))
  for (const g of groups) out.push(...statsLines(g))
  const byId = new Map(posts.map((p) => [p.id, p]))
  const best = summary.best
    .map((id) => byId.get(id))
    .filter((p): p is VoicePost => !!p && (!platform || p.platform === platform))
    .slice(0, 5)
  if (best.length) {
    out.push('Best performers:')
    for (const p of best) {
      const line = p.text.replace(/\s+/g, ' ').slice(0, 90)
      out.push(`  ${PLATFORM_NAMES[p.platform]}${metricText(p)}: ${line}${p.text.length > 90 ? '...' : ''}`)
    }
  }
  return out.join('\n')
}

function metricText(p: VoicePost): string {
  const bits: string[] = []
  if (p.views !== null) bits.push(`${shortNum(p.views)} views`)
  if (p.likes !== null) bits.push(`${shortNum(p.likes)} likes`)
  return bits.length ? `, ${bits.join(', ')}` : ''
}

export function shortNum(n: number): string {
  if (n >= 1e6) return `${round1(n / 1e6)}M`
  if (n >= 1e3) return `${round1(n / 1e3)}K`
  return String(n)
}

// the context pack

export interface VoiceContext {
  text: string
  chars: number
  budget: number
  profileChars: number
  summaryChars: number
  examples: number
  // examples that didn't fit
  skipped: number
}

function profileText(p: VoiceProfile, platform?: VoicePlatform): string {
  const out: string[] = []
  const line = (label: string, v: string | string[]): void => {
    const s = Array.isArray(v) ? v.join(', ') : v.trim()
    if (s) out.push(`${label}: ${s}`)
  }
  line('Who the brand is', p.about)
  line('Audience', p.audience)
  line('Tone', p.tone)
  line('Topics it covers', p.topics)
  line('Never says or does', p.never)
  line('Words it uses', p.useWords)
  line('Words it avoids', p.avoidWords)
  line('Emoji it uses', p.useEmoji.join(' '))
  line('Emoji it avoids', p.avoidEmoji.join(' '))
  line('Calls to action', p.ctas.join(' | '))
  line('Links', p.links.join(' '))
  line('Hashtags', p.hashtags.join(' '))
  const notes = VOICE_PLATFORMS.filter((k) => p.platformNotes[k] && (!platform || k === platform))
  for (const k of notes) line(`Notes for ${PLATFORM_NAMES[k]}`, p.platformNotes[k] ?? '')
  return out.join('\n')
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return max > 20 ? `${text.slice(0, max - 4).trimEnd()} ...` : ''
}

// which posts to show the agent: starred, same platform, did well, recent
export function rankExamples(posts: VoicePost[], platform?: VoicePlatform): VoicePost[] {
  const perf = performance(posts)
  const newest = Math.max(0, ...posts.map((p) => p.postedAt ?? p.addedAt))
  const oldest = Math.min(newest, ...posts.map((p) => p.postedAt ?? p.addedAt))
  const span = newest - oldest || 1
  const score = (p: VoicePost): number =>
    (p.starred ? 3 : 0) +
    (platform && p.platform === platform ? 2 : 0) +
    (perf.get(p.id) ?? 0.3) +
    (0.5 * ((p.postedAt ?? p.addedAt) - oldest)) / span
  return [...posts].sort((a, b) => score(b) - score(a))
}

const EXAMPLE_MAX = 800

export function buildContext(
  brandName: string,
  data: VoiceData,
  platform?: VoicePlatform,
  budgetChars: number = data.budget,
  parts: VoiceParts = data.parts
): VoiceContext {
  const budget = Math.max(200, Math.round(budgetChars))
  const head = platform
    ? `Brand voice for ${brandName}, writing for ${PLATFORM_NAMES[platform]}. Match how this brand writes.`
    : `Brand voice for ${brandName}. Match how this brand writes.`
  let text = head
  let profileChars = 0
  let summaryChars = 0
  // leave room for a few real posts, they show the voice best
  const withExamples = parts.examples && data.posts.length > 0
  const room = (share: number): number =>
    Math.min(budget - text.length, withExamples ? Math.round(budget * share) : budget)

  if (parts.profile) {
    const p = profileText(data.profile, platform)
    if (p) {
      const section = clip(`\n\n## Profile\n${p}`, room(0.4))
      text += section
      profileChars = section.length
    }
  }
  if (parts.summary) {
    const computed = summaryText(analyze(data.posts), data.posts, platform)
    const s = (data.summaryText ?? computed).trim()
    if (s) {
      const section = clip(`\n\n## How past posts look\n${s}`, room(0.3))
      text += section
      summaryChars = section.length
    }
  }
  let examples = 0
  let skipped = 0
  if (parts.examples && data.posts.length) {
    const title = '\n\n## Example posts'
    let block = ''
    for (const p of rankExamples(data.posts, platform)) {
      const when = p.postedAt ? `, ${new Date(p.postedAt).toISOString().slice(0, 10)}` : ''
      const star = p.starred ? ', a favorite' : ''
      const one = `\n\n[${PLATFORM_NAMES[p.platform]}${when}${metricText(p)}${star}]\n${clip(p.text, EXAMPLE_MAX)}`
      if (text.length + title.length + block.length + one.length > budget) {
        skipped++
        continue
      }
      block += one
      examples++
    }
    if (examples) text += title + block
  }
  return { text, chars: text.length, budget, profileChars, summaryChars, examples, skipped }
}
