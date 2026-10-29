import { app, BrowserWindow, ipcMain, net } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import fs from 'original-fs'
import { bootInfo, newer, readState, updatesDir, writeState } from './boot-state'
import { loadData } from './store'
import { linkUnpacked, unlinkUnpacked } from './unpacked-link'

const SIX_HOURS = 6 * 60 * 60 * 1000
const REPO = 'JoshWright22/TrendDeck'
// a beta build also takes newer betas, a normal build only normal releases
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=15`

// version of an update that is downloaded and waiting, shown as a button in the title bar
let ready: string | null = null
let installNow: (() => void) | null = null
let checkNow: (() => Promise<'latest' | 'downloading'>) | null = null
// the last check that finished, for the agent's app_status
let lastCheck: { at: number; result: 'latest' | 'downloading' | 'error' } | null = null

export function updateStatus(): { ready: string | null; lastCheck: typeof lastCheck } {
  return { ready, lastCheck }
}

ipcMain.handle('update:state', () => ready)
ipcMain.handle('update:install', () => installNow?.())

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged || !checkNow) return 'dev'
  if (ready) {
    return 'downloading'
  }
  try {
    return await checkNow()
  } catch (err) {
    console.error('update check failed', err)
    return 'error'
  }
})

// written next to each release by scripts/after-pack.cjs
interface Manifest {
  version: string
  // the app code archive, an asset on that release
  file: string
  sha512: string
  size: number
  // the installed shell it runs on. a different one means electron or the unpacked files changed
  shell: string
}

function parseManifest(raw: unknown): Manifest | null {
  const m = raw as Partial<Manifest> | null
  if (!m || typeof m !== 'object') return null
  const ok =
    typeof m.version === 'string' &&
    /^\d+\.\d+\.\d+/.test(m.version) &&
    typeof m.file === 'string' &&
    /^[A-Za-z0-9._-]+\.asar$/.test(m.file) &&
    typeof m.sha512 === 'string' &&
    typeof m.size === 'number' &&
    typeof m.shell === 'string'
  return ok ? (m as Manifest) : null
}

interface Release {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: { name: string; browser_download_url: string }[]
}

// the newest release this build may take, and its manifest. null when there's none, or the
// newest one is from before app code updates
async function fetchManifest(): Promise<(Manifest & { url: string }) | null> {
  const res = await net.fetch(RELEASES_URL, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`release list failed: ${res.status}`)
  const beta = app.getVersion().includes('-')
  const releases = ((await res.json()) as Release[])
    .filter((r) => !r.draft && (beta || !r.prerelease) && /^v\d+\.\d+\.\d+/.test(r.tag_name))
    .sort((a, b) => (newer(a.tag_name.slice(1), b.tag_name.slice(1)) ? -1 : 1))
  const latest = releases[0]
  const asset = (name: string): string | undefined => latest?.assets.find((x) => x.name === name)?.browser_download_url
  const manifestUrl = asset('app-update.json')
  if (!latest || !manifestUrl) return null
  const m = parseManifest(await (await net.fetch(manifestUrl, { cache: 'no-store' })).json())
  const url = m ? asset(m.file) : undefined
  return m && url && m.version === latest.tag_name.slice(1) ? { ...m, url } : null
}

// downloads the app code to app-updates/<version>.asar, checked against the manifest's hash
async function download(m: Manifest & { url: string }): Promise<string> {
  const dir = updatesDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `${m.version}.asar`)
  const part = `${file}.part`
  const res = await net.fetch(m.url)
  if (!res.ok || !res.body) throw new Error(`app update download failed: ${res.status}`)
  const hash = createHash('sha512')
  const out = fs.createWriteStream(part)
  let size = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > m.size) throw new Error('app update is bigger than its manifest says')
      hash.update(value)
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    fs.rmSync(part, { force: true })
    throw err
  }
  if (size !== m.size || hash.digest('base64') !== m.sha512) {
    fs.rmSync(part, { force: true })
    throw new Error('app update failed its hash check')
  }
  fs.renameSync(part, file)
  linkUnpacked(file)
  return file
}

// leaves only the archive that's running or waiting
function cleanUp(): void {
  try {
    const keep = readState()?.file
    for (const name of fs.readdirSync(updatesDir())) {
      const full = join(updatesDir(), name)
      if (name === 'state.json' || full === keep || full === `${keep}.unpacked`) continue
      // a link (the native-files link next to a downloaded archive) is removed as a link. a
      // recursive rm goes through a windows junction and deletes what it points to, which once
      // emptied the installed app's app.asar.unpacked
      if (fs.lstatSync(full).isSymbolicLink()) unlinkUnpacked(full)
      else fs.rmSync(full, { force: true, recursive: true })
    }
  } catch {
    // no folder yet
  }
}

// restarting is all it takes, boot.ts picks the downloaded code up
// asked from outside (TrendDeck.exe --update-now while it runs): check now, and once the update is
// downloaded start again on it as soon as no reply is being written and no editor holds unsaved work
export async function updateNow(busy: () => boolean): Promise<void> {
  if (!checkNow) return
  const res = await checkNow().catch((err) => {
    console.error('update check failed', err)
    return 'error' as const
  })
  if (res !== 'downloading') return
  const until = Date.now() + 2 * 60 * 60_000
  const tick = (): void => {
    if (Date.now() > until) return
    if (installNow && !busy()) return installNow()
    setTimeout(tick, 15_000)
  }
  tick()
}

function relaunch(): void {
  app.relaunch()
  app.quit()
}

// New versions come from the GitHub releases page. The check sends nothing about you, it only asks
// GitHub for the latest version file. Turn it off with settings.autoUpdate = false.
export async function setupUpdater(): Promise<void> {
  if (!app.isPackaged) return
  cleanUp()
  // loaded here and not at the top, it pulls in a lot and the dev build never needs it
  // its autoUpdater is a lazy getter node can't see as a named export, so it's on default
  const { autoUpdater } = (await import('electron-updater')).default
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = app.getVersion().includes('-')
  autoUpdater.on('error', (err) => console.error('update check failed', err))

  const offer = (version: string, install: () => void): void => {
    installNow = install
    ready = version
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:ready', ready)
  }

  // the full installer, only when the shell itself changed. silent, then starts the app again
  autoUpdater.on('update-downloaded', (info) => offer(info.version, () => autoUpdater.quitAndInstall(true, true)))

  let busy = false
  // 'latest', 'downloading' (app code), or 'full' when only the installer can do it
  const checkApp = async (): Promise<'latest' | 'downloading' | 'full'> => {
    const m = await fetchManifest()
    if (!m) return 'full'
    if (!newer(m.version, app.getVersion())) return 'latest'
    if (m.shell !== bootInfo()?.shell) return 'full'
    const waiting = readState()
    if (waiting?.version === m.version && fs.existsSync(waiting.file)) {
      offer(m.version, relaunch)
      return 'downloading'
    }
    if (busy) return 'downloading'
    busy = true
    void download(m)
      .then((file) => {
        writeState({ version: m.version, file, shell: m.shell, tries: 0 })
        offer(m.version, relaunch)
      })
      .catch((err) => {
        console.error('app update failed', err)
      })
      .finally(() => {
        busy = false
      })
    return 'downloading'
  }

  const run = async (): Promise<'latest' | 'downloading'> => {
    try {
      const code = await checkApp()
      const result = code !== 'full' ? code : (await autoUpdater.checkForUpdates())?.isUpdateAvailable ? 'downloading' : 'latest'
      lastCheck = { at: Date.now(), result }
      return result
    } catch (err) {
      lastCheck = { at: Date.now(), result: 'error' }
      throw err
    }
  }

  const check = async (): Promise<void> => {
    try {
      const data = await loadData()
      const settings = data.settings as { autoUpdate?: boolean }
      if (settings.autoUpdate === false) return
      await run()
    } catch (err) {
      console.error('update check failed', err)
    }
  }

  checkNow = run

  // a download that finished last time is already waiting in state.json, boot.ts used it if it
  // could, so this only matters when it came in while the app was open
  setTimeout(() => void check(), 3_000)
  setInterval(() => void check(), SIX_HOURS)
}
