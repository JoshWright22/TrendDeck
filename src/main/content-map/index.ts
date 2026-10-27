import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { ID_PATTERN } from '@shared/types'
import { registerTools } from '../gateway/call'
import { registerSecretSource } from '../gateway/secrets'
import { allPosts, onChange as onPostingChange } from '../posting/store'
import { getData } from '../store'
import {
  channelState,
  clearClient,
  connect,
  disconnect,
  dropLearning,
  importCsv,
  keepLearning,
  mapView,
  ownLearning,
  removePillar,
  setClient,
  setProject,
  setPublicChannel,
  snapshotTick,
  sync,
  trackPosted,
  videoDetail
} from './service'
import { dropMap, loadAuth, loadMap, openSecrets } from './store'
import { CONTENT_MAP_TOOLS } from './tools'

// the content map: past videos per brand with their numbers, the channel's baseline, pillars,
// post-publish snapshots and post-mortems. see service.ts for the work, tools.ts for the agent

export { CONTENT_MAP_TOOLS }

const TICK_MS = 5 * 60_000
// the catalog syncs on its own once a day
const SYNC_EVERY = 24 * 3600_000

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
function brandArg(e: IpcMainInvokeEvent, v: unknown): string {
  if (!fromApp(e) || typeof v !== 'string' || !ID_PATTERN.test(v)) throw new Error('bad content map call')
  return v
}
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

let ticking = false
async function tickAll(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    for (const b of getData()?.brands ?? []) {
      // a stale catalog first, so new uploads are on the schedule before the snapshots
      const m = await loadMap(b.id)
      const connected = !!(await loadAuth(b.id))
      if ((connected || m.publicChannel) && (!m.lastSync || Date.now() - m.lastSync > SYNC_EVERY)) {
        await sync(b.id).catch((err) => console.error('content map: sync failed', err instanceof Error ? err.message : err))
      }
      await snapshotTick(b.id).catch((err) => console.error('content map: snapshot tick failed', err instanceof Error ? err.message : err))
    }
  } finally {
    ticking = false
  }
}

// a YouTube post TrendDeck made joins the snapshot schedule right away
const seenPosts = new Set<string>()
function watchPosts(): void {
  for (const p of allPosts()) {
    if (p.platform !== 'youtube' || p.status !== 'posted' || !p.url || seenPosts.has(p.id)) continue
    seenPosts.add(p.id)
    const id = p.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1]
    if (id) void trackPosted(p.brandId, id, p.title, p.url, p.updatedAt).catch(() => {})
  }
}

export function setupContentMap(): void {
  registerTools(CONTENT_MAP_TOOLS)
  registerSecretSource(openSecrets)

  ipcMain.handle('content-map:view', (e, b: unknown) => mapView(brandArg(e, b)))
  ipcMain.handle('content-map:detail', (e, b: unknown, id: unknown) => videoDetail(brandArg(e, b), text(id, 100)))
  ipcMain.handle('content-map:sync', (e, b: unknown) => sync(brandArg(e, b)))
  ipcMain.handle('content-map:set-client', async (e, id: unknown, secret: unknown) => {
    if (!fromApp(e)) throw new Error('bad content map call')
    await setClient(text(id, 300), text(secret, 300))
    return null
  })
  ipcMain.handle('content-map:clear-client', (e) => {
    if (!fromApp(e)) throw new Error('bad content map call')
    return clearClient()
  })
  ipcMain.handle('content-map:connect', (e, b: unknown) => connect(brandArg(e, b)))
  ipcMain.handle('content-map:disconnect', (e, b: unknown) => disconnect(brandArg(e, b)))
  ipcMain.handle('content-map:public-channel', (e, b: unknown, ch: unknown) => setPublicChannel(brandArg(e, b), text(ch, 200)))
  ipcMain.handle('content-map:import-csv', async (e, b: unknown) => {
    const brandId = brandArg(e, b)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'YouTube Studio export', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile' as const] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return null
    const st = await fs.stat(pick.filePaths[0])
    if (st.size > 20 * 1024 * 1024) throw new Error('That file is too big for a Studio export.')
    return importCsv(brandId, await fs.readFile(pick.filePaths[0], 'utf8'))
  })
  ipcMain.handle('content-map:remove-pillar', (e, b: unknown, id: unknown) => removePillar(brandArg(e, b), text(id, 40)))
  ipcMain.handle('content-map:set-project', (e, b: unknown, videoId: unknown, projectId: unknown) =>
    setProject(brandArg(e, b), text(videoId, 100), typeof projectId === 'string' && ID_PATTERN.test(projectId) ? projectId : null)
  )
  ipcMain.handle('content-map:keep-learning', (e, b: unknown, card: unknown, id: unknown, t: unknown) => keepLearning(brandArg(e, b), text(card, 100), text(id, 40), text(t, 600)))
  ipcMain.handle('content-map:drop-learning', (e, b: unknown, card: unknown, id: unknown) => dropLearning(brandArg(e, b), text(card, 100), text(id, 40)))
  ipcMain.handle('content-map:add-learning', (e, b: unknown, card: unknown, t: unknown) => ownLearning(brandArg(e, b), text(card, 100), text(t, 600)))
  ipcMain.handle('content-map:state', (e, b: unknown) => channelState(brandArg(e, b)))

  onPostingChange(watchPosts)
  // catch up on snapshots that came due while the app was closed, once the window is up
  setTimeout(() => {
    watchPosts()
    void tickAll()
  }, 20_000).unref?.()
  setInterval(() => void tickAll(), TICK_MS).unref?.()
}

export async function dropContentMap(brandId: string): Promise<void> {
  await dropMap(brandId)
}
