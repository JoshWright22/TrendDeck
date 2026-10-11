import { app, BrowserWindow, ipcMain, session } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  ID_PATTERN,
  partitionFor,
  TREND_SOURCES,
  type TrendFeed,
  type TrendItem,
  type TrendSource
} from '@shared/types'
import { getData } from '../store'
import { SOURCES, type Ctx, type RawItem } from './sources'

const STALE_MS = 3 * 3600_000
const CHECK_MS = 10 * 60_000
const PER_SOURCE = 30
const MAX_POINTS = 24
// keeps a refresh to a sane number of requests
const MAX_KEYWORDS = 5
const MAX_SUBREDDITS = 8

const feeds = new Map<string, TrendFeed>()
const running = new Map<string, Promise<void>>()

function dir(): string {
  return join(app.getPath('userData'), 'trends')
}

function file(brandId: string): string {
  return join(dir(), `${brandId}.json`)
}

async function readCache(brandId: string): Promise<TrendFeed | null> {
  const hit = feeds.get(brandId)
  if (hit) return hit
  try {
    const feed = JSON.parse(await fs.readFile(file(brandId), 'utf8')) as TrendFeed
    if (!Array.isArray(feed.items)) return null
    feed.refreshing = false
    feeds.set(brandId, feed)
    return feed
  } catch {
    return null
  }
}

async function writeCache(feed: TrendFeed): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  const tmp = `${file(feed.brandId)}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ ...feed, refreshing: false }), 'utf8')
  await fs.rename(tmp, file(feed.brandId))
}

export async function dropTrends(brandId: string): Promise<void> {
  feeds.delete(brandId)
  await fs.rm(file(brandId), { force: true })
}

function push(feed: TrendFeed): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('trends:update', feed)
}

// log scale against the source's best item, so one viral post doesn't flatten the rest.
// stuff that's only big in general gets halved so it doesn't crowd out the niche
function score(items: RawItem[]): TrendItem[] {
  const top = items.reduce((m, i) => Math.max(m, i.velocity), 0)
  const scale = Math.log1p(top) || 1
  return items.map(({ value: _value, general, ...i }) => {
    const s = (100 * Math.log1p(Math.max(0, i.velocity))) / scale
    return { ...i, score: Math.round(general ? s / 2 : s) }
  })
}

// keep each item's earlier readings so the trend line grows over refreshes
function withHistory(fresh: RawItem[], old: TrendFeed | null): RawItem[] {
  const before = new Map(old?.items.map((i) => [i.id, i]) ?? [])
  const now = Date.now()
  return fresh.map((item) => {
    // tiktok sends its own curve
    if (item.source === 'tiktok') return item
    const prev = before.get(item.id)?.points ?? item.points
    const points = [...prev.filter(([t]) => t < now - 60_000), [now, item.value] as [number, number]]
    return { ...item, points: points.slice(-MAX_POINTS) }
  })
}

async function runRefresh(brandId: string): Promise<void> {
  const data = getData()
  const brand = data?.brands.find((b) => b.id === brandId)
  if (!data || !brand) return
  const old = await readCache(brandId)
  const started: TrendFeed = old
    ? { ...old, refreshing: true }
    : { brandId, fetchedAt: 0, items: [], errors: {}, refreshing: true }
  feeds.set(brandId, started)
  push(started)

  const ctx: Ctx = {
    ses: session.fromPartition(partitionFor(brandId)),
    keywords: brand.keywords.slice(0, MAX_KEYWORDS),
    subreddits: brand.subreddits.slice(0, MAX_SUBREDDITS),
    youtubeApiKey: data.settings.youtubeApiKey
  }
  const errors: TrendFeed['errors'] = {}
  const results = await Promise.all(
    TREND_SOURCES.map(async (source: TrendSource) => {
      try {
        const raw = await SOURCES[source](ctx)
        raw.sort((a, b) => b.velocity - a.velocity)
        return score(withHistory(raw.slice(0, PER_SOURCE), old))
      } catch (err) {
        errors[source] = err instanceof Error ? err.message : String(err)
        // keep what we had from this source last time
        return old?.items.filter((i) => i.source === source) ?? []
      }
    })
  )
  const items = results.flat().sort((a, b) => b.score - a.score || b.velocity - a.velocity)
  const feed: TrendFeed = { brandId, fetchedAt: Date.now(), items, errors, refreshing: false }
  feeds.set(brandId, feed)
  push(feed)
  await writeCache(feed).catch(() => {})
}

export function refreshTrends(brandId: string): Promise<void> {
  const busy = running.get(brandId)
  if (busy) return busy
  const job = runRefresh(brandId).finally(() => running.delete(brandId))
  running.set(brandId, job)
  return job
}

function isStale(feed: TrendFeed | null): boolean {
  return !feed || Date.now() - feed.fetchedAt > STALE_MS
}

export function setupTrends(): void {
  ipcMain.handle('trends:get', async (_event, brandId: unknown) => {
    if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) return null
    const feed = await readCache(brandId)
    if (isStale(feed)) void refreshTrends(brandId)
    return feeds.get(brandId) ?? feed
  })

  ipcMain.handle('trends:refresh', async (_event, brandId: unknown) => {
    if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) return
    await refreshTrends(brandId)
  })

  // auto refresh the brand you have open every few hours, even if trends isn't on screen
  setInterval(() => {
    const id = getData()?.activeBrandId
    if (!id) return
    void readCache(id).then((feed) => {
      if (isStale(feed)) void refreshTrends(id)
    })
  }, CHECK_MS)
}
