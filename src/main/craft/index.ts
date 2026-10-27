import { app, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CraftAppStatus, CraftDock, CraftOpenRequest } from '@shared/craft'
import { registerToolSource } from '../gateway/call'
import { registerSecretSource } from '../gateway/secrets'
import { loadAllToolCaches, loadToolCache, pickFile, setupAgentSessions, stopAllSessions, stopSession } from './agent'
import { isAppId, spec } from './catalog'
import { setDock, setHost } from './dock'
import { checkUpdates, installLatest, loadInstalled, setRunningCheck, startUpdateChecks, uninstall } from './install'
import { close, closeAllForQuit, controlTokens, isRunning, launch, runningApp } from './launch'
import { appFiles, findProject, knownFolder, projectFolder } from './paths'
import { resolveInProject } from './rules'
import { allStatus, liveOf, onChanged, status } from './state'
import { craftAppTools, craftTools, setupCraftTurns } from './tools'

// the Craft App Suite: install, open docked over the workspace, and the agent's tools.
// see docs/DECISIONS-craft.md

// installs if needed, then opens the app on the project's file. an app open on something else
// is asked to close first (it can ask to save), a headless engine on it saves and stops
export async function openApp(req: CraftOpenRequest): Promise<CraftAppStatus> {
  const { appId, brandId, projectId } = req
  if (!isAppId(appId)) throw new Error('no craft app with that id')
  const { project } = findProject(brandId, projectId)
  if (liveOf(appId).install.kind !== 'installed') await installLatest(appId)
  const folder = await projectFolder(brandId, projectId)
  const asked = req.file ? resolveInProject(folder, req.file) : null
  const run = runningApp(appId)
  if (run && run.brandId === brandId && run.projectId === projectId && (!asked || asked.toLowerCase() === run.file?.toLowerCase())) {
    return status(appId)
  }
  if (run && !(await close(appId))) throw new Error(`${spec(appId).name} is still open, save or close what's in it first`)
  await stopSession(appId)
  const file = await pickFile(appId, folder, project.name, req.file ?? null)
  await launch({ appId, brandId, projectId, folder, file })
  return status(appId)
}

// only the app window, never a site tab
const fromApp = (e: IpcMainInvokeEvent | IpcMainEvent): boolean => e.sender.getType() === 'window'

function appIdOf(v: unknown): string {
  if (!isAppId(v)) throw new Error('no craft app with that id')
  return v
}

function cleanDock(raw: unknown): CraftDock | null {
  const d = raw as Partial<CraftDock> | null
  if (!d || !isAppId(d.appId)) return null
  const b = d.bounds
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000
  const bounds = b && num(b.x) && num(b.y) && num(b.width) && num(b.height) && b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
  return { appId: d.appId, bounds, visible: d.visible === true }
}

// the TrendDeck window the apps dock to, from index.ts createWindow
export function craftHost(win: BrowserWindow): void {
  setHost(win)
}

let quitting = false

export function setupCraft(): void {
  setRunningCheck(isRunning)
  registerSecretSource(controlTokens)
  registerToolSource(() => [
    ...craftTools(async (turn, appId, projectId, file) => {
      await openApp({ appId, brandId: turn.brandId, projectId, file })
    }),
    ...craftAppTools()
  ])
  setupAgentSessions()
  setupCraftTurns()
  // a fresh install has no tool list yet, its headless engine is asked for one
  const listed = new Map<string, string>()
  onChanged((id) => {
    const i = liveOf(id).install
    if (i.kind !== 'installed' || listed.get(id) === i.version) return
    listed.set(id, i.version)
    void loadToolCache(id)
  })

  ipcMain.handle('craft:list', (e) => (fromApp(e) ? allStatus() : []))
  ipcMain.handle('craft:install', async (e, appId: unknown) => {
    if (!fromApp(e)) throw new Error('bad craft call')
    const id = appIdOf(appId)
    await installLatest(id)
    return status(id)
  })
  ipcMain.handle('craft:uninstall', async (e, appId: unknown) => {
    if (!fromApp(e)) throw new Error('bad craft call')
    const id = appIdOf(appId)
    await stopSession(id, false)
    await uninstall(id)
  })
  ipcMain.handle('craft:open', (e, req: unknown) => {
    if (!fromApp(e) || !req || typeof req !== 'object') throw new Error('bad craft call')
    const r = req as Partial<CraftOpenRequest>
    if (typeof r.brandId !== 'string' || typeof r.projectId !== 'string') throw new Error('bad craft call')
    return openApp({ appId: appIdOf(r.appId), brandId: r.brandId, projectId: r.projectId, file: typeof r.file === 'string' ? r.file : null })
  })
  ipcMain.handle('craft:close', async (e, appId: unknown) => {
    if (!fromApp(e)) throw new Error('bad craft call')
    await close(appIdOf(appId))
  })
  ipcMain.on('craft:dock', (e, raw: unknown) => {
    if (!fromApp(e)) return
    const d = cleanDock(raw)
    if (d) setDock(d)
  })
  ipcMain.handle('craft:files', async (e, brandId: unknown, projectId: unknown, appId: unknown) => {
    if (!fromApp(e) || typeof brandId !== 'string' || typeof projectId !== 'string') return []
    const id = appIdOf(appId)
    findProject(brandId, projectId)
    // listing doesn't make the folder, a project with none has no files yet
    const folder = knownFolder(brandId, projectId)
    return folder ? appFiles(folder, id) : []
  })
  ipcMain.handle('craft:check-updates', async (e) => {
    if (!fromApp(e)) return []
    await checkUpdates(true)
    return allStatus()
  })

  void app.whenReady().then(async () => {
    await loadInstalled().catch((err) => console.error('craft: loading installs failed', err))
    void loadAllToolCaches()
    startUpdateChecks()
  })

  // TrendDeck quitting asks every open app to close (they can ask to save) and saves headless
  // engines. one that stays open (its save prompt is up) is left running on its own
  app.on('before-quit', (e) => {
    if (quitting) return
    const anyOpen = allStatus().some((s) => s.running || s.agent !== 'off')
    if (!anyOpen) return
    e.preventDefault()
    quitting = true
    void Promise.allSettled([closeAllForQuit(), stopAllSessions()]).finally(() => app.quit())
  })
}
