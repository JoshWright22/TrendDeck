import type { Session } from 'electron'
import type { StatPost, StatSnapshot } from '@shared/types'
import { fromAgo, getJson, getText, hiddenWindow, open, run, sleep, waitFor } from './page'
import { num, parseCount } from './stats'

export type Reading = Omit<StatSnapshot, 'at' | 'platform'>

const MAX_POSTS = 20

// walks any json and calls fn on every object, for page data whose shape keeps moving
function walk(value: unknown, fn: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 60 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const v of value) walk(v, fn, depth + 1)
    return
  }
  const o = value as Record<string, unknown>
  fn(o)
  for (const v of Object.values(o)) walk(v, fn, depth + 1)
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  const o = v as { simpleText?: string; runs?: { text?: string }[]; content?: string } | null
  if (!o) return ''
  if (typeof o.simpleText === 'string') return o.simpleText
  if (typeof o.content === 'string') return o.content
  if (Array.isArray(o.runs)) return o.runs.map((r) => r.text ?? '').join('')
  return ''
}

// youtube

function initialData(html: string): unknown {
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

async function youtubePublic(ses: Session, channelId: string): Promise<Partial<Reading>> {
  const html = await getText(ses, `https://www.youtube.com/channel/${channelId}/videos`)
  const data = initialData(html)
  const posts: StatPost[] = []
  let followers: number | null = null
  let account = ''
  walk(data, (o) => {
    const meta = o.channelMetadataRenderer as { title?: string } | undefined
    if (meta?.title) account = meta.title
    const subs = textOf(o.subscriberCountText)
    if (subs && followers === null) followers = parseCount(subs)
    // the newer header keeps "1.2K subscribers" in plain text parts
    if (typeof o.content === 'string' && /subscribers?$/i.test(o.content) && followers === null) {
      followers = parseCount(o.content)
    }
    const v = o.videoRenderer as Record<string, unknown> | undefined
    if (v && typeof v.videoId === 'string' && posts.length < MAX_POSTS) {
      posts.push({
        id: v.videoId,
        title: textOf(v.title),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        publishedAt: fromAgo(textOf(v.publishedTimeText)),
        views: parseCount(textOf(v.viewCountText)),
        likes: null,
        comments: null
      })
    }
  })
  return { account, followers, posts }
}

export async function youtubePage(ses: Session): Promise<Reading> {
  const win = hiddenWindow(ses)
  let channelId = ''
  let studioSubs: number | null = null
  try {
    await open(win, 'https://studio.youtube.com/')
    const end = Date.now() + 20000
    while (Date.now() < end && !channelId) {
      const url = win.webContents.getURL()
      if (/accounts\.google\.com|\/signin/.test(url)) {
        throw new Error('Not logged into YouTube Studio in this brand')
      }
      channelId = url.match(/\/channel\/(UC[\w-]{22})/)?.[1] ?? ''
      if (!channelId) await sleep(500)
    }
    if (!channelId) throw new Error("YouTube Studio didn't open a channel, open its tab once and check")
    // the dashboard card says "Current subscribers" with the exact count under it
    const text = await waitFor<string>(
      win,
      `(() => { const t = document.body.innerText; return /current subscribers/i.test(t) ? t : '' })()`
    )
    const m = text?.match(/current subscribers\s*\n?\s*([\d.,]+\s*[KMB]?)/i)
    if (m) studioSubs = parseCount(m[1])
  } finally {
    win.destroy()
  }
  const pub = await youtubePublic(ses, channelId).catch(() => ({}) as Partial<Reading>)
  return {
    via: 'page',
    account: pub.account || channelId,
    followers: studioSubs ?? pub.followers ?? null,
    views: null,
    likes: null,
    postCount: null,
    posts: pub.posts ?? []
  }
}

interface YtChannel {
  id: string
  snippet?: { title?: string }
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string }
  contentDetails?: { relatedPlaylists?: { uploads?: string } }
}

export async function youtubeApi(ses: Session, key: string, channel: string): Promise<Reading> {
  const base = 'https://www.googleapis.com/youtube/v3'
  const k = encodeURIComponent(key)
  const who = channel.startsWith('@')
    ? `forHandle=${encodeURIComponent(channel)}`
    : `id=${encodeURIComponent(channel)}`
  const ch = await getJson<{ items?: YtChannel[] }>(
    ses,
    `${base}/channels?part=snippet,statistics,contentDetails&${who}&key=${k}`
  )
  const c = ch.items?.[0]
  if (!c) throw new Error(`no channel found for ${channel}`)
  const posts: StatPost[] = []
  const uploads = c.contentDetails?.relatedPlaylists?.uploads
  if (uploads) {
    const list = await getJson<{ items?: { contentDetails?: { videoId?: string } }[] }>(
      ses,
      `${base}/playlistItems?part=contentDetails&maxResults=${MAX_POSTS}&playlistId=${uploads}&key=${k}`
    )
    const ids = (list.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean)
    if (ids.length) {
      const vids = await getJson<{
        items?: {
          id: string
          snippet?: { title?: string; publishedAt?: string }
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
        }[]
      }>(ses, `${base}/videos?part=snippet,statistics&id=${ids.join(',')}&key=${k}`)
      for (const v of vids.items ?? []) {
        posts.push({
          id: v.id,
          title: v.snippet?.title ?? '',
          url: `https://www.youtube.com/watch?v=${v.id}`,
          publishedAt: v.snippet?.publishedAt ? Date.parse(v.snippet.publishedAt) || null : null,
          views: num(v.statistics?.viewCount),
          likes: num(v.statistics?.likeCount),
          comments: num(v.statistics?.commentCount)
        })
      }
    }
  }
  return {
    via: 'api',
    account: c.snippet?.title ?? c.id,
    followers: num(c.statistics?.subscriberCount),
    views: num(c.statistics?.viewCount),
    likes: null,
    postCount: num(c.statistics?.videoCount),
    posts
  }
}

// tiktok

interface TikTokPage {
  user?: string
  nickname?: string
  followers?: number
  hearts?: number
  videos?: number
  posts?: { href: string; views: string; title: string }[]
}

const TIKTOK_SCOPE = `(() => {
  try {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
    return el ? JSON.parse(el.textContent || '{}').__DEFAULT_SCOPE__ || null : null
  } catch { return null }
})()`

export async function tiktokPage(ses: Session): Promise<Reading> {
  const win = hiddenWindow(ses)
  try {
    await open(win, 'https://www.tiktok.com/')
    type Scope = Record<string, { user?: { uniqueId?: string } }>
    const scope = await waitFor<Scope>(win, TIKTOK_SCOPE, 8000)
    const user = scope?.['webapp.app-context']?.user?.uniqueId
    if (!user || !/^[\w.]{1,40}$/.test(user)) throw new Error('Not logged into TikTok in this brand')
    await open(win, `https://www.tiktok.com/@${user}`)
    // the grid fills in after load, give it a few seconds
    await waitFor(win, `document.querySelectorAll('[data-e2e="user-post-item"]').length > 0`, 10000)
    const got = await run<TikTokPage>(
      win,
      `(() => {
        const scope = ${TIKTOK_SCOPE} || {}
        const info = (scope['webapp.user-detail'] || {}).userInfo || {}
        const stats = info.stats || {}
        const posts = [...document.querySelectorAll('[data-e2e="user-post-item"]')].slice(0, ${MAX_POSTS}).map((el) => {
          const a = el.querySelector('a[href*="/video/"], a[href*="/photo/"]')
          const v = el.querySelector('[data-e2e="video-views"]')
          const img = el.querySelector('img')
          return { href: a ? a.href : '', views: v ? v.textContent : '', title: img ? img.alt : '' }
        })
        return {
          user: (info.user || {}).uniqueId, nickname: (info.user || {}).nickname,
          followers: stats.followerCount, hearts: stats.heartCount, videos: stats.videoCount, posts
        }
      })()`
    )
    const posts: StatPost[] = (got.posts ?? [])
      .map((p): StatPost | null => {
        const id = p.href.match(/\/(?:video|photo)\/(\d+)/)?.[1]
        if (!id) return null
        return {
          id,
          title: (p.title ?? '').slice(0, 300),
          url: p.href,
          // tiktok ids carry the post time in their top bits
          publishedAt: Number(BigInt(id) >> 32n) * 1000 || null,
          views: parseCount(p.views),
          likes: null,
          comments: null
        }
      })
      .filter((p): p is StatPost => p !== null)
    return {
      via: 'page',
      account: `@${user}`,
      followers: num(got.followers),
      views: null,
      likes: num(got.hearts),
      postCount: num(got.videos),
      posts
    }
  } finally {
    win.destroy()
  }
}

export async function tiktokApi(ses: Session, token: string): Promise<Reading> {
  const auth = { authorization: `Bearer ${token}` }
  const info = await getJson<{
    data?: { user?: Record<string, unknown> }
    error?: { code?: string; message?: string }
  }>(
    ses,
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,follower_count,likes_count,video_count',
    { headers: auth }
  )
  const u = info.data?.user
  if (!u) throw new Error(info.error?.message || 'TikTok api sent no user')
  const list = await getJson<{ data?: { videos?: Record<string, unknown>[] } }>(
    ses,
    'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,share_url,view_count,like_count,comment_count',
    {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ max_count: MAX_POSTS })
    }
  ).catch(() => ({ data: { videos: [] } }))
  const posts = (list.data?.videos ?? []).map((v) => ({
    id: String(v.id ?? ''),
    title: String(v.title || v.video_description || ''),
    url: typeof v.share_url === 'string' ? v.share_url : '',
    publishedAt: num(v.create_time) ? (num(v.create_time) as number) * 1000 : null,
    views: num(v.view_count),
    likes: num(v.like_count),
    comments: num(v.comment_count)
  }))
  return {
    via: 'api',
    account: typeof u.username === 'string' ? `@${u.username}` : String(u.display_name ?? ''),
    followers: num(u.follower_count),
    views: null,
    likes: num(u.likes_count),
    postCount: num(u.video_count),
    posts
  }
}

// instagram

interface InstaPage {
  error?: string
  username?: string
  followers?: number
  media?: number
  items?: Record<string, unknown>[]
}

export async function instagramPage(ses: Session): Promise<Reading> {
  const cookies = await ses.cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' })
  const userId = cookies[0]?.value ?? ''
  if (!/^\d{1,30}$/.test(userId)) throw new Error('Not logged into Instagram in this brand')
  const win = hiddenWindow(ses)
  try {
    await open(win, 'https://www.instagram.com/')
    await sleep(1500)
    // same calls the site makes for your own profile, run from inside the page
    const got = await run<InstaPage>(
      win,
      `(async () => {
        const h = { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
        const get = async (u) => {
          const r = await fetch(u, { headers: h, credentials: 'include' })
          if (!r.ok) throw new Error('instagram said ' + r.status)
          return r.json()
        }
        try {
          const info = await get('/api/v1/users/${userId}/info/')
          const u = info.user || {}
          let items = []
          try {
            const feed = await get('/api/v1/feed/user/${userId}/?count=${MAX_POSTS}')
            items = feed.items || []
          } catch {}
          return { username: u.username, followers: u.follower_count, media: u.media_count, items }
        } catch (e) { return { error: String(e && e.message || e) } }
      })()`
    )
    if (got.error) throw new Error(got.error)
    const posts: StatPost[] = (got.items ?? []).slice(0, MAX_POSTS).map((i) => {
      const code = typeof i.code === 'string' ? i.code : String(i.pk ?? '')
      const caption = (i.caption as { text?: string } | null)?.text ?? ''
      return {
        id: code,
        title: caption.slice(0, 300),
        url: /^[\w-]+$/.test(code) ? `https://www.instagram.com/p/${code}/` : '',
        publishedAt: num(i.taken_at) ? (num(i.taken_at) as number) * 1000 : null,
        views: num(i.play_count) ?? num(i.view_count) ?? num(i.ig_play_count),
        likes: num(i.like_count),
        comments: num(i.comment_count)
      }
    })
    return {
      via: 'page',
      account: got.username ? `@${got.username}` : userId,
      followers: num(got.followers),
      views: null,
      likes: null,
      postCount: num(got.media),
      posts
    }
  } finally {
    win.destroy()
  }
}

export async function instagramApi(ses: Session, token: string): Promise<Reading> {
  const t = encodeURIComponent(token)
  const me = await getJson<Record<string, unknown>>(
    ses,
    `https://graph.instagram.com/me?fields=user_id,username,followers_count,media_count&access_token=${t}`
  )
  const media = await getJson<{ data?: Record<string, unknown>[] }>(
    ses,
    `https://graph.instagram.com/me/media?fields=id,caption,permalink,timestamp,like_count,comments_count&limit=${MAX_POSTS}&access_token=${t}`
  ).catch(() => ({ data: [] }))
  const posts = (media.data ?? []).map((m) => ({
    id: String(m.id ?? ''),
    title: typeof m.caption === 'string' ? m.caption : '',
    url: typeof m.permalink === 'string' ? m.permalink : '',
    publishedAt: typeof m.timestamp === 'string' ? Date.parse(m.timestamp) || null : null,
    views: null,
    likes: num(m.like_count),
    comments: num(m.comments_count)
  }))
  return {
    via: 'api',
    account: typeof me.username === 'string' ? `@${me.username}` : '',
    followers: num(me.followers_count),
    views: null,
    likes: null,
    postCount: num(me.media_count),
    posts
  }
}
