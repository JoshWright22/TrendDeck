import { BrowserWindow, ipcMain, session } from 'electron'
import {
  ID_PATTERN,
  partitionFor,
  STAT_PLATFORMS,
  type AnalyticsDoc,
  type StatPlatform,
  type StatSnapshot
} from '@shared/types'
import { getData } from '../store'
import { dropJson, readJson, writeJson } from './files'
import { cleanWriterDoc } from './drafts'
import { cleanAnalyticsDoc, cleanConfig, cleanSnapshot } from './stats'
import {
  instagramApi,
  instagramPage,
  tiktokApi,
  tiktokPage,
  youtubeApi,
  youtubePage,
  type Reading
} from './readers'

const validId = (id: unknown): id is string => typeof id === 'string' && ID_PATTERN.test(id)

async function loadDoc(brandId: string): Promise<AnalyticsDoc> {
  return cleanAnalyticsDoc(await readJson('analytics', brandId))
}

// api first when it's set up, the logged in page when it isn't or the api fails
async function read(brandId: string, platform: StatPlatform, doc: AnalyticsDoc): Promise<Reading> {
  const ses = session.fromPartition(partitionFor(brandId))
  const cfg = doc.config
  const page = { youtube: youtubePage, tiktok: tiktokPage, instagram: instagramPage }[platform]
  let api: (() => Promise<Reading>) | null = null
  const ytKey = getData()?.settings.youtubeApiKey ?? ''
  if (platform === 'youtube' && ytKey && cfg.youtubeChannel) {
    api = () => youtubeApi(ses, ytKey, cfg.youtubeChannel)
  } else if (platform === 'tiktok' && cfg.tiktokToken) {
    api = () => tiktokApi(ses, cfg.tiktokToken)
  } else if (platform === 'instagram' && cfg.instagramToken) {
    api = () => instagramApi(ses, cfg.instagramToken)
  }
  if (!api) return page(ses)
  try {
    return await api()
  } catch (apiErr) {
    try {
      return await page(ses)
    } catch (pageErr) {
      const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      throw new Error(`api: ${msg(apiErr)}. page: ${msg(pageErr)}`)
    }
  }
}

function progress(brandId: string, platform: StatPlatform | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('analytics:progress', brandId, platform)
  }
}

const running = new Map<string, Promise<AnalyticsDoc>>()

async function runRefresh(brandId: string, platforms: StatPlatform[]): Promise<AnalyticsDoc> {
  const doc = await loadDoc(brandId)
  // one at a time so a cheap laptop isn't running three hidden pages at once
  for (const platform of platforms) {
    progress(brandId, platform)
    const at = Date.now()
    try {
      const reading = await read(brandId, platform, doc)
      const snap = cleanSnapshot({ ...reading, at, platform } satisfies StatSnapshot)
      if (snap) doc.snapshots.push(snap)
      const empty = reading.followers === null && reading.posts.length === 0
      doc.lastRun[platform] = {
        at,
        ok: !empty,
        message: empty ? 'opened the page but found no numbers' : `read via ${reading.via}`
      }
    } catch (err) {
      doc.lastRun[platform] = { at, ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
  progress(brandId, null)
  const clean = cleanAnalyticsDoc(doc)
  await writeJson('analytics', brandId, clean)
  return clean
}

export async function dropAnalytics(brandId: string): Promise<void> {
  await dropJson('analytics', brandId)
  await dropJson('writer', brandId)
}

export function setupAnalytics(): void {
  ipcMain.handle('writer:load', async (_event, brandId: unknown) => {
    if (!validId(brandId)) return { drafts: [] }
    return cleanWriterDoc(await readJson('writer', brandId))
  })

  ipcMain.handle('writer:save', async (_event, brandId: unknown, doc: unknown) => {
    if (!validId(brandId)) return
    await writeJson('writer', brandId, cleanWriterDoc(doc))
  })

  ipcMain.handle('analytics:load', async (_event, brandId: unknown) => {
    if (!validId(brandId)) return cleanAnalyticsDoc(null)
    return loadDoc(brandId)
  })

  ipcMain.handle('analytics:config', async (_event, brandId: unknown, config: unknown) => {
    if (!validId(brandId)) return cleanAnalyticsDoc(null)
    // wait for a refresh in flight so it doesn't write over the new config
    await running.get(brandId)?.catch(() => {})
    const doc = await loadDoc(brandId)
    doc.config = cleanConfig(config)
    await writeJson('analytics', brandId, doc)
    return doc
  })

  ipcMain.handle('analytics:clear', async (_event, brandId: unknown) => {
    if (!validId(brandId)) return cleanAnalyticsDoc(null)
    await running.get(brandId)?.catch(() => {})
    const doc = await loadDoc(brandId)
    const clean = { ...doc, snapshots: [], lastRun: {} }
    await writeJson('analytics', brandId, clean)
    return clean
  })

  ipcMain.handle('analytics:refresh', async (_event, brandId: unknown, platforms: unknown) => {
    if (!validId(brandId)) return cleanAnalyticsDoc(null)
    const busy = running.get(brandId)
    if (busy) return busy
    const list = Array.isArray(platforms) ? STAT_PLATFORMS.filter((p) => platforms.includes(p)) : []
    const job = runRefresh(brandId, list).finally(() => running.delete(brandId))
    running.set(brandId, job)
    return job
  })
}
