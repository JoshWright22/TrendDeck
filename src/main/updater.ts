import { app, BrowserWindow, ipcMain } from 'electron'
import { loadData } from './store'

const SIX_HOURS = 6 * 60 * 60 * 1000
// only an update that was already downloaded last time installs on launch, that's ready in a few
// seconds, before you've touched anything. a fresh download never closes the app while you work:
// it waits for the Update button or installs when you quit
const INSTALL_ON_LAUNCH_MS = 8_000

// version of an update that is downloaded and waiting, shown as a button in the title bar
let ready: string | null = null
let installNow: (() => void) | null = null
// set while a check from the button is running, so its download installs as soon as it lands
let manual = false
let checkNow: (() => Promise<'latest' | 'downloading'>) | null = null

ipcMain.handle('update:state', () => ready)
ipcMain.handle('update:install', () => installNow?.())

// the Check for updates button: installs a waiting update, otherwise asks GitHub and installs what it finds
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged || !checkNow) return 'dev'
  if (ready) {
    installNow?.()
    return 'installing'
  }
  try {
    return await checkNow()
  } catch (err) {
    console.error('update check failed', err)
    return 'error'
  }
})

// New versions come from the GitHub releases page. The check sends nothing about you, it only asks
// GitHub for the latest version file. Turn it off with settings.autoUpdate = false.
export async function setupUpdater(): Promise<void> {
  if (!app.isPackaged) return
  // loaded here and not at the top, it pulls in a lot and the dev build never needs it
  // its autoUpdater is a lazy getter node can't see as a named export, so it's on default
  const { autoUpdater } = (await import('electron-updater')).default
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => console.error('update check failed', err))
  const started = Date.now()
  // silent install, then start the app again
  installNow = () => autoUpdater.quitAndInstall(true, true)
  autoUpdater.on('update-downloaded', (info) => {
    if (manual || Date.now() - started < INSTALL_ON_LAUNCH_MS) {
      installNow?.()
      return
    }
    ready = info.version
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:ready', ready)
  })

  const check = async (): Promise<void> => {
    try {
      const data = await loadData()
      const settings = data.settings as { autoUpdate?: boolean }
      if (settings.autoUpdate === false) return
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.error('update check failed', err)
    }
  }

  checkNow = async () => {
    manual = true
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) {
      manual = false
      return 'latest'
    }
    return 'downloading'
  }

  // right after the window is up, so a waiting update goes in on launch
  setTimeout(() => void check(), 3_000)
  setInterval(() => void check(), SIX_HOURS)
}
