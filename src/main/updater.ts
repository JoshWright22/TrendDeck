import { app } from 'electron'
import { loadData } from './store'

const SIX_HOURS = 6 * 60 * 60 * 1000

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

  // wait a little so the check never slows the first paint
  setTimeout(() => void check(), 15_000)
  setInterval(() => void check(), SIX_HOURS)
}
