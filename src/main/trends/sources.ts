import type { Session } from 'electron'
import type { TrendItem, TrendSource } from '@shared/types'
import { compact, getJson, getText, HttpError, sleep, warmUp } from './net'

export interface Ctx {
  ses: Session
  keywords: string[]
  subreddits: string[]
  youtubeApiKey: string
}

// what a source returns before scoring, value is the raw count we chart over time,
// general means it isn't from the niche, just big everywhere
export type RawItem = Omit<TrendItem, 'score'> & { value: number; general?: boolean }

const HOUR = 3600_000

function hoursSince(t: number): number {
  return Math.max(1, (Date.now() - t) / HOUR)
}

/* reddit */

interface RedditPost {
  id: string
  title: string
  permalink: string
  subreddit: string
  score: number
  num_comments: number
  created_utc: number
  stickied?: boolean
}

interface RedditListing {
  data?: { children?: { kind: string; data: RedditPost }[] }
}

// reddit puts a js check in front of its json, a page load in the same session gets past it
async function redditJson(ctx: Ctx, url: string, warmed: { done: boolean }): Promise<RedditListing> {
  try {
    return await getJson<RedditListing>(ctx.ses, url)
  } catch (err) {
    if (warmed.done || !(err instanceof HttpError)) throw err
    warmed.done = true
    await warmUp(ctx.ses, 'https://www.reddit.com/')
    return getJson<RedditListing>(ctx.ses, url)
  }
}

export async function reddit(ctx: Ctx): Promise<RawItem[]> {
  // subreddit posts are on topic by definition, search hits only count if the title has a keyword word in it
  const urls: [string, string[] | null][] = [
    ...ctx.subreddits.map(
      (s) => [`https://www.reddit.com/r/${s}/hot.json?limit=30&raw_json=1`, null] as [string, null]
    ),
    ...ctx.keywords.map(
      (k) =>
        [
          `https://www.reddit.com/search.json?q=${encodeURIComponent(k)}&sort=top&t=day&limit=25&raw_json=1`,
          k.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
        ] as [string, string[]]
    )
  ]
  const warmed = { done: false }
  const seen = new Map<string, RawItem>()
  let lastError: unknown = null
  for (const [url, words] of urls) {
    let listing: RedditListing
    try {
      listing = await redditJson(ctx, url, warmed)
    } catch (err) {
      lastError = err
      continue
    }
    for (const child of listing.data?.children ?? []) {
      const p = child.data
      if (child.kind !== 't3' || p.stickied || seen.has(p.id)) continue
      const title = p.title.toLowerCase()
      if (words && words.length > 0 && !words.some((w) => title.includes(w))) continue
      const at = p.created_utc * 1000
      const value = p.score + 2 * p.num_comments
      seen.set(p.id, {
        id: `reddit:${p.id}`,
        source: 'reddit',
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        detail: `r/${p.subreddit}, ${compact(p.score)} upvotes, ${compact(p.num_comments)} comments`,
        publishedAt: at,
        velocity: value / hoursSince(at),
        value,
        points: [[at, 0]]
      })
    }
    await sleep(400)
  }
  if (seen.size === 0 && lastError) throw lastError
  return [...seen.values()]
}

/* youtube */

const UNIT_HOURS: [RegExp, number][] = [
  [/^(s|sec|second)/, 1 / 3600],
  [/^(mo|month)/, 24 * 30],
  [/^(m|min|minute)/, 1 / 60],
  [/^(h|hr|hour)/, 1],
  [/^(d|day)/, 24],
  [/^(w|wk|week)/, 24 * 7],
  [/^(y|yr|year)/, 24 * 365]
]

// "3 days ago", "2d ago", "Streamed 5 hours ago"
export function parseAgo(text: string): number | null {
  const m = /(\d+)\s*([a-z]+)/i.exec(text)
  if (!m) return null
  const unit = m[2].toLowerCase()
  const hit = UNIT_HOURS.find(([re]) => re.test(unit))
  return hit ? Date.now() - Number(m[1]) * hit[1] * HOUR : null
}

function parseCount(text: string): number {
  const digits = text.replace(/[^\d]/g, '')
  return digits ? Number(digits) : 0
}

interface VideoRenderer {
  videoId: string
  title?: { runs?: { text: string }[] }
  ownerText?: { runs?: { text: string }[] }
  viewCountText?: { simpleText?: string }
  publishedTimeText?: { simpleText?: string }
}

function findVideos(node: unknown, out: VideoRenderer[]): void {
  if (!node || typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  if (rec.videoRenderer) {
    out.push(rec.videoRenderer as VideoRenderer)
    return
  }
  for (const v of Object.values(rec)) findVideos(v, out)
}

function videoItem(
  id: string,
  title: string,
  channel: string,
  views: number,
  at: number
): RawItem {
  return {
    id: `youtube:${id}`,
    source: 'youtube',
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    detail: `${channel}, ${compact(views)} views`,
    publishedAt: at,
    velocity: views / hoursSince(at),
    value: views,
    points: [[at, 0]]
  }
}

// search results page, this week, sorted by views
async function youtubePage(ctx: Ctx, keyword: string): Promise<RawItem[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=CAMSAggD&hl=en&gl=US`
  const html = await getText(ctx.ses, url)
  const start = html.indexOf('var ytInitialData = ')
  const end = html.indexOf(';</script>', start)
  if (start < 0 || end < 0) throw new Error("youtube changed its page, couldn't read results")
  const videos: VideoRenderer[] = []
  findVideos(JSON.parse(html.slice(start + 20, end)), videos)
  const items: RawItem[] = []
  for (const v of videos) {
    // live streams have no publish time, skip them
    const at = parseAgo(v.publishedTimeText?.simpleText ?? '')
    if (!v.videoId || at === null) continue
    const title = v.title?.runs?.map((r) => r.text).join('') ?? ''
    const channel = v.ownerText?.runs?.[0]?.text ?? 'YouTube'
    items.push(videoItem(v.videoId, title, channel, parseCount(v.viewCountText?.simpleText ?? ''), at))
  }
  return items
}

interface ApiSearch {
  items?: { id?: { videoId?: string } }[]
}

interface ApiVideos {
  items?: {
    id: string
    snippet: { title: string; channelTitle: string; publishedAt: string }
    statistics: { viewCount?: string }
  }[]
}

// official api, used when there's a key in settings
async function youtubeApi(ctx: Ctx, keyword: string): Promise<RawItem[]> {
  const key = encodeURIComponent(ctx.youtubeApiKey)
  const after = new Date(Date.now() - 7 * 24 * HOUR).toISOString()
  const search = await getJson<ApiSearch>(
    ctx.ses,
    `https://www.googleapis.com/youtube/v3/search?part=id&type=video&order=viewCount&maxResults=25&publishedAfter=${after}&q=${encodeURIComponent(keyword)}&key=${key}`
  )
  const ids = (search.items ?? []).map((i) => i.id?.videoId).filter(Boolean)
  if (ids.length === 0) return []
  const videos = await getJson<ApiVideos>(
    ctx.ses,
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.join(',')}&key=${key}`
  )
  return (videos.items ?? []).map((v) =>
    videoItem(
      v.id,
      v.snippet.title,
      v.snippet.channelTitle,
      Number(v.statistics.viewCount ?? 0),
      Date.parse(v.snippet.publishedAt)
    )
  )
}

export async function youtube(ctx: Ctx): Promise<RawItem[]> {
  const seen = new Map<string, RawItem>()
  let lastError: unknown = null
  for (const k of ctx.keywords) {
    try {
      const items = ctx.youtubeApiKey ? await youtubeApi(ctx, k) : await youtubePage(ctx, k)
      for (const i of items) if (!seen.has(i.id)) seen.set(i.id, i)
    } catch (err) {
      lastError = err
    }
    await sleep(400)
  }
  if (seen.size === 0 && lastError) throw lastError
  return [...seen.values()]
}

/* google trends */

interface Widget {
  id: string
  token: string
  request: unknown
}

interface RankedKeyword {
  query: string
  value: number
  formattedValue: string
}

interface RelatedSearches {
  default?: { rankedList?: { rankedKeyword?: RankedKeyword[] }[] }
}

// google prefixes its json with junk so it can't be loaded as a script
function stripGuard(text: string): string {
  return text.slice(text.indexOf('{'))
}

async function trendsJson<T>(ctx: Ctx, url: string): Promise<T> {
  return JSON.parse(stripGuard(await getText(ctx.ses, url))) as T
}

async function relatedQueries(ctx: Ctx, keyword: string, time: string): Promise<RankedKeyword[][]> {
  // google finds nothing for "Game Development" but plenty for "game development"
  const req = { comparisonItem: [{ keyword: keyword.toLowerCase(), geo: '', time }], category: 0, property: '' }
  const explore = await trendsJson<{ widgets?: Widget[] }>(
    ctx,
    `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`
  )
  const widget = explore.widgets?.find((w) => w.id === 'RELATED_QUERIES')
  if (!widget) return []
  const related = await trendsJson<RelatedSearches>(
    ctx,
    `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`
  )
  // list 0 is top, list 1 is rising
  return (related.default?.rankedList ?? []).map((l) => l.rankedKeyword ?? [])
}

// broad keywords often have nothing rising this week, so widen to three months, then
// fall back to what people search most with it
async function risingQueries(ctx: Ctx, keyword: string): Promise<RankedKeyword[]> {
  const week = await relatedQueries(ctx, keyword, 'now 7-d')
  if (week[1]?.length) return week[1]
  await sleep(800)
  const month = await relatedQueries(ctx, keyword, 'today 3-m')
  if (month[1]?.length) return month[1]
  return (month[0]?.length ? month[0] : (week[0] ?? [])).map((r) => ({ ...r, formattedValue: 'Top' }))
}

export async function google(ctx: Ctx): Promise<RawItem[]> {
  const seen = new Map<string, RawItem>()
  let lastError: unknown = null
  let warmed = false
  for (const k of ctx.keywords) {
    let rising: RankedKeyword[] = []
    try {
      rising = await risingQueries(ctx, k)
    } catch (err) {
      // a cold session gets 429s until google has handed out its cookie
      if (warmed || !(err instanceof HttpError && err.status === 429)) {
        lastError = err
        continue
      }
      warmed = true
      await getText(ctx.ses, 'https://trends.google.com/trends/explore?q=' + encodeURIComponent(k)).catch(
        () => {}
      )
      await sleep(1500)
      try {
        rising = await risingQueries(ctx, k)
      } catch (again) {
        lastError = again
      }
    }
    const now = Date.now()
    for (const r of rising) {
      const id = `google:${r.query.toLowerCase()}`
      if (seen.has(id)) continue
      seen.set(id, {
        id,
        source: 'google',
        title: r.query,
        url: `https://trends.google.com/trends/explore?date=now%207-d&q=${encodeURIComponent(r.query)}`,
        detail:
          r.formattedValue === 'Top'
            ? `Top search with "${k}"`
            : `${r.formattedValue} searches, from "${k}"`,
        publishedAt: null,
        velocity: r.value,
        value: r.value,
        points: [[now, r.value]]
      })
    }
    await sleep(1200)
  }
  if (seen.size === 0 && lastError) throw lastError
  return [...seen.values()]
}

/* tiktok creative center */

interface Hashtag {
  hashtagID: string
  hashtagName: string
  publishCnt: string
  vv: string
  popularityCurve?: { timestamp: string; value: number }[]
}

export async function tiktok(ctx: Ctx): Promise<RawItem[]> {
  // same call the creative center page makes, logged in through the brand's session you get the full list
  const body = await getJson<{ items?: Hashtag[] }>(
    ctx.ses,
    'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        referer: 'https://ads.tiktok.com/creative/creativeCenter/trends/hashtag'
      },
      body: JSON.stringify({ timeRange: 7, countryCode: 'US', page: 1, limit: 50 })
    }
  )
  const tags = body.items ?? []
  const words = ctx.keywords.flatMap((k) => k.toLowerCase().split(/\s+/)).filter((w) => w.length > 2)
  const matches = tags.filter((t) => words.some((w) => t.hashtagName.toLowerCase().includes(w)))
  // logged out you only get a handful of global tags, show those rather than nothing
  const general = matches.length === 0
  const picked = general ? tags : matches
  return picked.map((t) => {
    const views = Number(t.vv) || 0
    const posts = Number(t.publishCnt) || 0
    return {
      id: `tiktok:${t.hashtagID}`,
      source: 'tiktok' as TrendSource,
      title: `#${t.hashtagName}`,
      url: `https://www.tiktok.com/tag/${encodeURIComponent(t.hashtagName)}`,
      detail: `${general ? 'Big on TikTok overall, ' : ''}${compact(posts)} posts, ${compact(views)} views this week`,
      publishedAt: null,
      velocity: views / (7 * 24),
      value: views,
      general,
      points: (t.popularityCurve ?? []).map((p) => [Number(p.timestamp) * 1000, p.value])
    }
  })
}

export const SOURCES: Record<TrendSource, (ctx: Ctx) => Promise<RawItem[]>> = {
  reddit,
  youtube,
  google,
  tiktok
}
