import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { loadData } from './store'

const SIX_HOURS = 6 * 60 * 60 * 1000

// New versions come from the GitHub releases page. The check sends nothing about you, it only asks
// GitHub for the latest version file. Turn it off with settings.autoUpdate = false.
export function setupUpdater(): void {
  if (!app.isPackaged) return
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
