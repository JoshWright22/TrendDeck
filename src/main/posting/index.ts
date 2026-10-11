import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { ID_PATTERN } from '@shared/types'
import {
  PLATFORMS,
  PLATFORM_RULES,
  type CheckReport,
  type LogEntry,
  type Platform,
  type PostItem,
  type PostMode,
  type StepReport
} from '@shared/posting'
import { ADAPTERS } from './adapters'
import {
  Closed,
  StepError,
  isDone,
  markPostButton,
  openWindow,
  pressPost,
  runSteps,
  windowTitle,
  type Session
} from './driver'
import { postViaApi, connectYouTube } from './api'
import * as store from './store'

const TICK_MS = 20 * 1000
// due more than this long ago when the app opens, it waits for you instead of firing late
const LATE_MS = 60 * 60 * 1000
const DONE_POLL_MS = 2000

const isPlatform = (v: unknown): v is Platform => (PLATFORMS as readonly unknown[]).includes(v)
const validId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

// the app windows, not the posting ones
const posting = new Set<number>()
// review windows that are still open, by post id
const open = new Map<string, Session>()

function broadcast(): void {
  const state = store.getState()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!posting.has(w.id) && !w.isDestroyed()) w.webContents.send('posting:update', state)
  }
}

function log(post: PostItem, mode: PostMode, result: LogEntry['result'], message: string): Promise<void> {
  return store.addLog({
    id: randomUUID(),
    at: Date.now(),
    postId: post.id,
    brandId: post.brandId,
    platform: post.platform,
    mode,
    result,
    message
  })
}

// a reason it can't go out, or null when it's good
async function problem(post: PostItem, mode: PostMode): Promise<string | null> {
  const rules = PLATFORM_RULES[post.platform]
  if (rules.needsTitle && !post.title.trim()) return 'needs a title'
  if (post.platform === 'reddit' && !post.subreddit) return 'needs a subreddit'
  if (mode === 'api' && post.platform === 'instagram') {
    if (!post.mediaUrl) return 'api mode needs a public link to the media'
    return null
  }
  if (rules.needsMedia && !post.mediaPath) return 'needs an image or video'
  if (post.mediaPath) {
    const st = await fs.stat(post.mediaPath).catch(() => null)
    if (!st?.isFile()) return `can't find the media file at ${post.mediaPath}`
  }
  if (!post.body.trim() && !post.mediaPath && !post.title.trim()) return 'nothing to post'
  return null
}

let busy = false
const line: string[] = []

function enqueue(id: string): void {
  if (!line.includes(id)) line.push(id)
  void pump()
}

async function pump(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (line.length) {
      const id = line.shift() as string
      await runOne(id).catch(() => {})
    }
  } finally {
    busy = false
  }
}

async function runOne(id: string): Promise<void> {
  const post = store.getPost(id)
  if (!post || post.status === 'posted' || post.status === 'review') return
  const settings = store.brandSettings(post.brandId)
  const mode = settings.modes[post.platform]
  const bad = await problem(post, mode)
  if (bad) {
    await store.patchPost(id, { status: 'failed', note: bad })
    await log(post, mode, 'failed', bad)
    return
  }
  await store.patchPost(id, { status: 'running', note: '' })
  if (mode === 'api') {
    try {
      const url = await postViaApi(post, store.getKeys(post.brandId, post.platform))
      await store.patchPost(id, { status: 'posted', note: '', url })
      await log(post, 'api', 'posted', url ? `posted, ${url}` : 'posted')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await store.patchPost(id, { status: 'failed', note: msg })
      await log(post, 'api', 'failed', msg)
    }
    return
  }
  await runTabs(post, settings.autoPost)
}

async function runTabs(post: PostItem, autoPost: boolean): Promise<void> {
  const adapter = ADAPTERS[post.platform]
  const s = openWindow(post.brandId, windowTitle(post, false), true)
  posting.add(s.win.id)
  const id = post.id
  try {
    await runSteps(s, {
      post,
      adapter,
      onStep: (name) => void store.patchPost(id, { note: name })
    })
  } catch (err) {
    const closed = err instanceof Closed
    const msg = closed
      ? 'window closed before it got to the Post button'
      : err instanceof StepError
        ? `step "${err.step}" broke: ${err.message}`
        : String(err)
    await store.patchPost(id, { status: closed ? 'closed' : 'failed', note: msg })
    await log(post, 'tabs', closed ? 'closed' : 'failed', msg)
    // a broken step stays open so you can finish by hand or see what changed
    if (!closed) watch(post, s, 'failed')
    return
  }

  if (autoPost) {
    try {
      await pressPost(s, adapter)
      const end = Date.now() + 3 * 60 * 1000
      while (Date.now() < end) {
        if (await isDone(s, adapter)) {
          const url = s.win.webContents.getURL()
          await store.patchPost(id, { status: 'posted', note: '', url: post.platform === 'reddit' ? url : '' })
          await log(post, 'tabs', 'posted', 'posted by the app')
          setTimeout(() => !s.closed() && s.win.close(), 3000)
          return
        }
        await new Promise((r) => setTimeout(r, DONE_POLL_MS))
      }
      const msg = "pressed Post but couldn't see it go out, check the window"
      await store.patchPost(id, { status: 'review', note: msg })
      await log(post, 'tabs', 'review', msg)
      watch(post, s, 'review')
    } catch (err) {
      const msg = err instanceof Closed ? 'window closed right after pressing Post' : String(err)
      await store.patchPost(id, { status: 'closed', note: msg })
      await log(post, 'tabs', 'closed', msg)
    }
    return
  }

  await markPostButton(s, adapter)
  await store.patchPost(id, { status: 'review', note: 'filled in, press Post when it looks right' })
  await log(post, 'tabs', 'review', 'filled in and waiting for you to press Post')
  s.win.show()
  s.win.focus()
  watch(post, s, 'review')
}

// keeps an eye on an open window until the post shows up or you close it
function watch(post: PostItem, s: Session, from: 'review' | 'failed'): void {
  open.set(post.id, s)
  const adapter = ADAPTERS[post.platform]
  const timer = setInterval(() => {
    if (s.closed()) return
    void isDone(s, adapter)
      .then(async (done) => {
        if (!done || s.closed()) return
        clearInterval(timer)
        open.delete(post.id)
        const url = post.platform === 'reddit' ? s.win.webContents.getURL() : ''
        await store.patchPost(post.id, { status: 'posted', note: '', url })
        await log(post, 'tabs', 'posted', 'you pressed Post')
        setTimeout(() => !s.closed() && s.win.close(), 3000)
      })
      .catch(() => {})
  }, DONE_POLL_MS)
  s.win.on('closed', () => {
    clearInterval(timer)
    posting.delete(s.win.id)
    open.delete(post.id)
    const cur = store.getPost(post.id)
    if (!cur || cur.status === 'posted') return
    if (from === 'review' && cur.status === 'review') {
      const msg = "window closed and the app didn't see it go out"
      void store.patchPost(post.id, { status: 'closed', note: msg })
      void log(post, 'tabs', 'closed', msg)
    }
  })
}

// due posts go in line, ones the app slept through get flagged
async function tick(first: boolean): Promise<void> {
  const now = Date.now()
  for (const p of store.allPosts()) {
    if (p.status === 'running' || (p.status === 'queued' && first)) {
      // the app quit mid post last time
      if (first) {
        await store.patchPost(p.id, { status: 'failed', note: 'the app closed while this was running' })
      }
      continue
    }
    if (p.status === 'review' && first) {
      await store.patchPost(p.id, { status: 'closed', note: 'the app closed while this was open for review' })
      continue
    }
    if (p.status !== 'scheduled' || p.scheduledAt === null || p.scheduledAt > now) continue
    if (first && now - p.scheduledAt > LATE_MS) {
      const msg = 'the app was closed when this was due'
      await store.patchPost(p.id, { status: 'missed', note: msg })
      await log(p, store.brandSettings(p.brandId).modes[p.platform], 'missed', msg)
      continue
    }
    await store.patchPost(p.id, { status: 'queued', note: 'due now' })
    enqueue(p.id)
  }
}

async function selfCheck(brandId: string, platform: Platform, subreddit: string): Promise<CheckReport> {
  const post: PostItem = {
    id: 'self-check',
    brandId,
    platform,
    title: '',
    body: '',
    mediaPath: '',
    mediaUrl: '',
    subreddit: subreddit || 'test',
    visibility: 'private',
    scheduledAt: null,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    note: '',
    url: ''
  }
  const s = openWindow(brandId, windowTitle(post, true), true)
  posting.add(s.win.id)
  let steps: StepReport[] = []
  try {
    steps = await runSteps(s, { post, adapter: ADAPTERS[platform], check: true })
  } catch (err) {
    const r = (err as { report?: StepReport[] }).report
    steps = r ?? [{ name: 'window', state: 'broke', detail: err instanceof Error ? err.message : String(err) }]
  } finally {
    if (!s.closed()) s.win.close()
    posting.delete(s.win.id)
  }
  const ok = !steps.some((x) => x.state === 'broke')
  const broke = steps.find((x) => x.state === 'broke')
  await store.addLog({
    id: randomUUID(),
    at: Date.now(),
    postId: null,
    brandId,
    platform,
    mode: 'tabs',
    result: 'check',
    message: ok ? 'self-check passed' : `self-check: "${broke?.name}" broke, ${broke?.detail}`
  })
  return { platform, at: Date.now(), ok, steps }
}

export function setupPosting(): void {
  store.onChange(broadcast)

  // posting windows go away with the app window, otherwise they'd keep the app running
  app.on('browser-window-created', (_e, w) => {
    setImmediate(() => {
      if (posting.has(w.id)) return
      w.on('closed', () => {
        const left = BrowserWindow.getAllWindows().filter((x) => !posting.has(x.id) && x !== w)
        if (left.length) return
        for (const x of BrowserWindow.getAllWindows()) if (posting.has(x.id)) x.close()
      })
    })
  })

  ipcMain.handle('posting:get', async () => {
    await store.loadPosting()
    return store.getState()
  })

  ipcMain.handle('posting:save', async (_e, raw: unknown) => {
    if (!Array.isArray(raw)) return
    const posts = raw
      .map(store.cleanPost)
      .filter((p): p is PostItem => p !== null)
      // the app owns these, the page can't set them
      .map((p) => {
        const cur = store.getPost(p.id)
        const busyNow = cur && (cur.status === 'running' || cur.status === 'review' || cur.status === 'queued')
        return busyNow ? { ...p, status: cur.status } : p
      })
    await store.putPosts(posts)
  })

  ipcMain.handle('posting:remove', async (_e, id: unknown) => {
    if (!validId(id)) return
    const s = open.get(id)
    if (s && !s.closed()) s.win.close()
    await store.removePost(id)
  })

  ipcMain.handle('posting:run', async (_e, id: unknown) => {
    if (!validId(id)) return
    const p = store.getPost(id)
    if (!p || p.status === 'running' || p.status === 'review' || p.status === 'queued') return
    await store.patchPost(id, { status: 'queued', note: busy ? 'waiting for the post before it' : '' })
    enqueue(id)
  })

  ipcMain.handle('posting:mark-posted', async (_e, id: unknown) => {
    if (!validId(id)) return
    const p = store.getPost(id)
    if (!p) return
    await store.patchPost(id, { status: 'posted', note: 'marked posted by you' })
    await log(p, store.brandSettings(p.brandId).modes[p.platform], 'posted', 'marked posted by you')
  })

  ipcMain.handle('posting:focus', (_e, id: unknown) => {
    const s = validId(id) ? open.get(id) : undefined
    if (!s || s.closed()) return false
    s.win.show()
    s.win.focus()
    return true
  })

  ipcMain.handle('posting:pick-media', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Pick an image or video',
      properties: ['openFile'],
      filters: [
        { name: 'Images and videos', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'm4v'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle('posting:set-brand', async (_e, brandId: unknown, patch: unknown) => {
    if (!validId(brandId) || !patch || typeof patch !== 'object') return
    const p = patch as { autoPost?: unknown; modes?: Record<string, unknown> }
    const modes: Partial<Record<Platform, PostMode>> = {}
    for (const [k, v] of Object.entries(p.modes ?? {})) {
      if (isPlatform(k) && (v === 'api' || v === 'tabs')) modes[k] = v
    }
    const cur = store.brandSettings(brandId)
    await store.patchBrand(brandId, {
      autoPost: typeof p.autoPost === 'boolean' ? p.autoPost : cur.autoPost,
      modes: { ...cur.modes, ...modes }
    })
  })

  ipcMain.handle('posting:set-keys', async (_e, brandId: unknown, platform: unknown, values: unknown) => {
    if (!validId(brandId) || !isPlatform(platform)) return
    if (values !== null && (typeof values !== 'object' || Array.isArray(values))) return
    await store.setKeys(brandId, platform, values as Record<string, string> | null)
  })

  ipcMain.handle('posting:connect-youtube', async (_e, brandId: unknown) => {
    if (!validId(brandId)) return 'bad brand'
    try {
      const token = await connectYouTube(store.getKeys(brandId, 'youtube'), brandId)
      await store.setKeys(brandId, 'youtube', { refreshToken: token })
      return 'connected'
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })

  ipcMain.handle('posting:check', async (_e, brandId: unknown, platform: unknown, sub: unknown) => {
    if (!validId(brandId) || !isPlatform(platform)) throw new Error('bad check')
    const subreddit = typeof sub === 'string' ? sub.replace(/[^A-Za-z0-9_]/g, '').slice(0, 21) : ''
    return selfCheck(brandId, platform, subreddit)
  })

  ipcMain.handle('posting:clear-log', async (_e, brandId: unknown) => {
    if (validId(brandId)) await store.clearLog(brandId)
  })

  // scheduled posts only fire while the app is open
  void store.loadPosting().then(async () => {
    await tick(true)
    setInterval(() => void tick(false), TICK_MS)
  })
}

// a deleted brand takes its queue, log and keys with it
export async function dropPostingBrand(brandId: string): Promise<void> {
  for (const [id, s] of open) {
    if (store.getPost(id)?.brandId === brandId && !s.closed()) s.win.close()
  }
  await store.dropBrand(brandId)
}
