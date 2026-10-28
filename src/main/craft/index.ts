import { app, dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CraftAppStatus, CraftDock, CraftOpenRequest } from '@shared/craft'
import { webSpec } from '@shared/craft-web'
import { registerToolSource } from '../gateway/call'
import { registerSecretSource } from '../gateway/secrets'
import { loadAllToolCaches, loadToolCache, pickFile, setupAgentSessions, stopAllSessions, stopSession } from './agent'
import { isAppId, spec } from './catalog'
import { dockState, setDock, setHost } from './dock'
import { checkUpdates, ensureWeb, installLatest, loadInstalled, setRunningCheck, startUpdateChecks, uninstall } from './install'
import { close, closeAllForQuit, controlTokens, isRunning, launch, runningApp } from './launch'
import { appFiles, findProject, knownFolder, projectFolder } from './paths'
import { resolveInProject } from './rules'
import { allStatus, liveOf, onChanged, status } from './state'
import { craftAppTools, craftTools, setupCraftTurns } from './tools'
import { hasWebEmbeds, releaseAllWeb, releaseWeb, setupWebSession, webEmbedOn } from './web'

// the Craft App Suite: install, open in the chat (the apps' web builds, web.ts) or as the full app
// in its own window, and the agent's tools. see docs/DECISIONS-craft.md and DECISIONS-craft-web.md

// installs if needed, then makes the app ready on the project's file. an app with a web build opens
// in the chat: the card that shows it loads the project, so here it's only installed and the file
// made. full (or an app without one) opens the desktop app in its own window: an editor in the chat
// on that project saves and lets go first, an app open on something else is asked to close (it can
// ask to save), a headless engine on it saves and stops
export async function openApp(req: CraftOpenRequest): Promise<CraftAppStatus> {
  const { appId, brandId, projectId } = req
  if (!isAppId(appId)) throw new Error('no craft app with that id')
  const { project } = findProject(brandId, projectId)
  if (liveOf(appId).install.kind !== 'installed') await installLatest(appId)
  const folder = await projectFolder(brandId, projectId)
  if (webSpec(appId) && !req.full) {
    await ensureWeb(appId)
    await pickFile(appId, folder, project.name, req.file ?? null)
    return status(appId)
  }
  const inChat = webEmbedOn(appId, brandId, projectId)
  if (inChat) await releaseWeb(inChat)
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
  const rect = (r: unknown): { x: number; y: number; width: number; height: number } | null => {
    const v = r as Partial<{ x: number; y: number; width: number; height: number }> | null
    return v && num(v.x) && num(v.y) && num(v.width) && num(v.height) && v.width > 0 && v.height > 0 ? { x: v.x, y: v.y, width: v.width, height: v.height } : null
  }
  const bounds = rect(b)
  return { appId: d.appId, bounds, visible: d.visible === true, clip: bounds ? rect(d.clip) : null }
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
    await stopSession(id)
    await uninstall(id)
  })
  ipcMain.handle('craft:open', (e, req: unknown) => {
    if (!fromApp(e) || !req || typeof req !== 'object') throw new Error('bad craft call')
    const r = req as Partial<CraftOpenRequest>
    if (typeof r.brandId !== 'string' || typeof r.projectId !== 'string') throw new Error('bad craft call')
    return openApp({ appId: appIdOf(r.appId), brandId: r.brandId, projectId: r.projectId, file: typeof r.file === 'string' ? r.file : null, full: r.full === true })
  })
  ipcMain.handle('craft:close', async (e, appId: unknown) => {
    if (!fromApp(e)) throw new Error('bad craft call')
    if (!(await close(appIdOf(appId)))) throw new Error('The editor is still open. Save or cancel its dialog in the editor; TrendDeck will not force it closed.')
  })
  ipcMain.on('craft:dock', (e, raw: unknown) => {
    if (!fromApp(e)) return
    const d = cleanDock(raw)
    if (d) setDock(d)
  })
  ipcMain.handle('craft:dock-state', (e, appId: unknown) => {
    if (!fromApp(e)) throw new Error('bad craft call')
    return dockState(appIdOf(appId))
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
    setupWebSession()
    await loadInstalled().catch((err) => console.error('craft: loading installs failed', err))
    void loadAllToolCaches()
    startUpdateChecks()
  })

  const QUIT_WAIT_MS = 45_000
  // TrendDeck quitting asks every open app to close (they can ask to save) and saves headless
  // engines. one that stays open (its save prompt is up) is left running on its own
  app.on('before-quit', (e) => {
    if (quitting) return
    const anyOpen = allStatus().some((s) => s.running || s.agent !== 'off') || hasWebEmbeds()
    if (!anyOpen) return
    e.preventDefault()
    quitting = true
    // an editor stuck on a job never answers its save: the app would stay running with no window
    // and hold the project, so after a while it quits anyway. everything up to the last save and
    // the recovery copies in .trenddeck/autosaves are on disk
    setTimeout(() => {
      if (!quitting) return
      console.error('craft: an editor did not finish saving, quitting anyway')
      app.exit(0)
    }, QUIT_WAIT_MS).unref()
    void releaseAllWeb().then(() => closeAllForQuit()).then(async () => {
      await stopAllSessions()
      app.quit()
    }).catch((error) => {
      quitting = false
      console.error('craft: quitting cancelled because editor changes could not be saved', error)
      void dialog.showMessageBox({ type: 'error', title: 'Editor changes are not saved', message: 'TrendDeck stayed open to protect your editor changes. Save or recover the project, then try closing or updating again.' })
    })
  })
}
