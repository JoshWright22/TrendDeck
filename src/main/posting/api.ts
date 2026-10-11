import { BrowserWindow, net } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import type { PostItem } from '@shared/posting'
import { partitionFor } from '@shared/types'

// official api mode, only runs when you queue a post for a platform set to api

type Keys = Record<string, string>

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v']
const isVideo = (path: string): boolean => VIDEO_EXT.includes(extname(path).toLowerCase())

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4'
}
const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'

async function json<T>(res: Response, who: string): Promise<T> {
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // some errors come back as html
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string } | string; detail?: string; title?: string } | null
    const msg =
      (typeof b?.error === 'object' ? b.error.message : b?.error) || b?.detail || b?.title || text.slice(0, 200)
    throw new Error(`${who} said ${res.status}: ${msg}`)
  }
  return body as T
}

function need(keys: Keys, ...names: string[]): void {
  const missing = names.filter((n) => !keys[n])
  if (missing.length) throw new Error(`missing ${missing.join(', ')} in Posting setup`)
}

async function readChunk(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

// youtube

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

// desktop oauth with a loopback redirect. the sign in opens in a window on the brand's session,
// so a google account already logged in there is picked up instead of asking again
export function connectYouTube(keys: Keys, brandId: string): Promise<string> {
  need(keys, 'clientId', 'clientSecret')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    let redirect = ''
    let win: BrowserWindow | null = null
    let done = false
    const finish = (): void => {
      done = true
      clearTimeout(timer)
      server.close()
      const w = win
      win = null
      if (w && !w.isDestroyed()) setTimeout(() => !w.isDestroyed() && w.close(), 1500)
    }
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirect)
      if (u.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const code = u.searchParams.get('code')
      const ok = code && u.searchParams.get('state') === state
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        ok
          ? '<p style="font-family:sans-serif">TrendDeck is connected to YouTube. You can close this tab.</p>'
          : '<p style="font-family:sans-serif">Sign in didn\'t finish. Close this tab and try again.</p>'
      )
      clearTimeout(timer)
      server.close()
      if (!ok) {
        reject(new Error(u.searchParams.get('error') ?? 'sign in cancelled'))
        return
      }
      void (async () => {
        const res2 = await net.fetch(GOOGLE_TOKEN, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: code as string,
            client_id: keys.clientId,
            client_secret: keys.clientSecret,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirect
          }).toString()
        })
        const t = await json<{ refresh_token?: string }>(res2, 'Google')
        if (!t.refresh_token) throw new Error('Google sent no refresh token, remove the app from your Google account and connect again')
        resolve(t.refresh_token)
      })().catch(reject)
    })
    const timer = setTimeout(() => {
      finish()
      reject(new Error('sign in timed out'))
    }, 5 * 60 * 1000)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      redirect = `http://127.0.0.1:${port}`
      const url = `${GOOGLE_AUTH}?${new URLSearchParams({
        client_id: keys.clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: YT_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      })}`
      win = new BrowserWindow({
        width: 520,
        height: 700,
        autoHideMenuBar: true,
        backgroundColor: '#0E0E10',
        title: 'Connect YouTube',
        webPreferences: {
          partition: partitionFor(brandId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.on('closed', () => {
        if (done) return
        finish()
        reject(new Error('sign in cancelled'))
      })
      void win.loadURL(url)
    })
  })
}

async function youtubeToken(keys: Keys): Promise<string> {
  need(keys, 'clientId', 'clientSecret')
  if (!keys.refreshToken) throw new Error('YouTube isn\'t connected, press Connect in Posting setup')
  const res = await net.fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.clientId,
      client_secret: keys.clientSecret,
      refresh_token: keys.refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  })
  const t = await json<{ access_token: string }>(res, 'Google')
  return t.access_token
}

const YT_CHUNK = 32 * 256 * 1024

async function youtube(post: PostItem, keys: Keys): Promise<string> {
  const token = await youtubeToken(keys)
  const size = (await fs.stat(post.mediaPath)).size
  const start = await net.fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': mimeOf(post.mediaPath)
      },
      body: JSON.stringify({
        snippet: { title: post.title.slice(0, 100), description: post.body.slice(0, 5000) },
        status: { privacyStatus: post.visibility, selfDeclaredMadeForKids: false }
      })
    }
  )
  if (!start.ok) await json(start, 'YouTube')
  const uploadUrl = start.headers.get('location')
  if (!uploadUrl) throw new Error('YouTube gave no upload link')
  let offset = 0
  for (;;) {
    const chunk = await readChunk(post.mediaPath, offset, Math.min(YT_CHUNK, size - offset))
    const end = offset + chunk.length - 1
    const res = await net.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-range': `bytes ${offset}-${end}/${size}`
      },
      body: new Uint8Array(chunk)
    })
    if (res.status === 308) {
      const range = res.headers.get('range')
      offset = range ? Number(range.split('-')[1]) + 1 : end + 1
      continue
    }
    const v = await json<{ id: string }>(res, 'YouTube')
    return `https://www.youtube.com/watch?v=${v.id}`
  }
}

// tiktok content posting api, direct post

const TT = 'https://open.tiktokapis.com/v2/post/publish'
const TT_CHUNK = 10 * 1024 * 1024

async function tiktok(post: PostItem, keys: Keys): Promise<string> {
  need(keys, 'accessToken')
  const auth = { authorization: `Bearer ${keys.accessToken}`, 'content-type': 'application/json; charset=UTF-8' }
  const info = await json<{ data: { privacy_level_options?: string[] } }>(
    await net.fetch(`${TT}/creator_info/query/`, { method: 'POST', headers: auth }),
    'TikTok'
  )
  const options = info.data.privacy_level_options ?? ['SELF_ONLY']
  const want = post.visibility === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY'
  // apps that tiktok hasn't reviewed can only post private
  const privacy = options.includes(want) ? want : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0]
  const size = (await fs.stat(post.mediaPath)).size
  const chunkSize = size < TT_CHUNK ? size : TT_CHUNK
  const count = Math.max(1, Math.floor(size / chunkSize))
  const init = await json<{ data: { publish_id: string; upload_url: string } }>(
    await net.fetch(`${TT}/video/init/`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        post_info: { title: post.body.slice(0, 2200), privacy_level: privacy },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count }
      })
    }),
    'TikTok'
  )
  for (let i = 0; i < count; i++) {
    const from = i * chunkSize
    // the last chunk takes whatever is left
    const len = i === count - 1 ? size - from : chunkSize
    const chunk = await readChunk(post.mediaPath, from, len)
    const res = await net.fetch(init.data.upload_url, {
      method: 'PUT',
      headers: {
        'content-type': mimeOf(post.mediaPath),
        'content-range': `bytes ${from}-${from + chunk.length - 1}/${size}`
      },
      body: new Uint8Array(chunk)
    })
    if (!res.ok) await json(res, 'TikTok upload')
  }
  const end = Date.now() + 10 * 60 * 1000
  while (Date.now() < end) {
    await sleep(4000)
    const st = await json<{ data: { status: string; fail_reason?: string } }>(
      await net.fetch(`${TT}/status/fetch/`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ publish_id: init.data.publish_id })
      }),
      'TikTok'
    )
    if (st.data.status === 'PUBLISH_COMPLETE') return ''
    if (st.data.status === 'FAILED') throw new Error(`TikTok failed it: ${st.data.fail_reason ?? 'no reason given'}`)
  }
  throw new Error('TikTok is still processing it, check your profile in a bit')
}

// instagram graph api, the media has to be at a public link instagram can download

const IG_VERSION = 'v23.0'

async function instagram(post: PostItem, keys: Keys): Promise<string> {
  need(keys, 'userId', 'accessToken')
  // tokens from instagram login start with IG, facebook login tokens use the facebook host
  const host = keys.accessToken.startsWith('IG') ? 'https://graph.instagram.com' : 'https://graph.facebook.com'
  const base = `${host}/${IG_VERSION}`
  const video = isVideo(new URL(post.mediaUrl).pathname)
  const params = new URLSearchParams({ caption: post.body.slice(0, 2200), access_token: keys.accessToken })
  if (video) {
    params.set('media_type', 'REELS')
    params.set('video_url', post.mediaUrl)
  } else {
    params.set('image_url', post.mediaUrl)
  }
  const user = encodeURIComponent(keys.userId)
  const made = await json<{ id: string }>(
    await net.fetch(`${base}/${user}/media`, { method: 'POST', body: params }),
    'Instagram'
  )
  const end = Date.now() + 10 * 60 * 1000
  for (;;) {
    const st = await json<{ status_code?: string; status?: string }>(
      await net.fetch(
        `${base}/${made.id}?fields=status_code,status&access_token=${encodeURIComponent(keys.accessToken)}`
      ),
      'Instagram'
    )
    if (st.status_code === 'FINISHED' || (!video && !st.status_code)) break
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error(`Instagram couldn't use the media: ${st.status ?? st.status_code}`)
    }
    if (Date.now() > end) throw new Error('Instagram took too long to process the media')
    await sleep(3000)
  }
  const pub = await json<{ id: string }>(
    await net.fetch(`${base}/${user}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: made.id, access_token: keys.accessToken })
    }),
    'Instagram'
  )
  const link = await json<{ permalink?: string }>(
    await net.fetch(`${base}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(keys.accessToken)}`),
    'Instagram'
  ).catch(() => ({ permalink: '' }))
  return link.permalink ?? ''
}

// x api v2, text and one image

async function x(post: PostItem, keys: Keys): Promise<string> {
  need(keys, 'accessToken')
  const auth = `Bearer ${keys.accessToken}`
  const body: { text: string; media?: { media_ids: string[] } } = { text: post.body.slice(0, 280) }
  if (post.mediaPath) {
    if (isVideo(post.mediaPath)) throw new Error('videos through the X api aren\'t in yet, use tabs mode for this one')
    const file = await fs.readFile(post.mediaPath)
    const form = new FormData()
    form.append('media', new Blob([new Uint8Array(file)], { type: mimeOf(post.mediaPath) }), basename(post.mediaPath))
    form.append('media_category', 'tweet_image')
    const up = await json<{ data?: { id: string }; media_id_string?: string }>(
      await net.fetch('https://api.x.com/2/media/upload', {
        method: 'POST',
        headers: { authorization: auth },
        body: form
      }),
      'X media upload'
    )
    const id = up.data?.id ?? up.media_id_string
    if (!id) throw new Error('X gave no media id back')
    body.media = { media_ids: [id] }
  }
  const res = await json<{ data: { id: string } }>(
    await net.fetch('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    'X'
  )
  return `https://x.com/i/status/${res.data.id}`
}

export async function postViaApi(post: PostItem, keys: Keys): Promise<string> {
  switch (post.platform) {
    case 'youtube':
      return youtube(post, keys)
    case 'tiktok':
      return tiktok(post, keys)
    case 'instagram':
      return instagram(post, keys)
    case 'x':
      return x(post, keys)
    default:
      throw new Error('Reddit only posts through your logged in tab')
  }
}
