import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'
import { ID_PATTERN, isHttpUrl, partitionFor, type AppData } from '@shared/types'
import { loadData, saveData } from './store'

const PARTITION_PREFIX = 'persist:brand-'

// some sites refuse to log in when the user agent says Electron
function plainUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${app.getName()}/\\S+`, 'i'), '')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    title: 'TrendDeck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // the app window only ever shows the app itself
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // site tabs get no preload and no node, and must live in a brand partition
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    const partition = params.partition ?? ''
    if (!partition.startsWith(PARTITION_PREFIX) || !isHttpUrl(params.src ?? '')) {
      event.preventDefault()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  // login flows open popups, those stay in the same brand session
  contents.setWindowOpenHandler(({ url }) => {
    if (!isHttpUrl(url)) return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
  })
})

ipcMain.handle('data:load', () => loadData())

ipcMain.handle('data:save', (_event, data: AppData) => saveData(data))

ipcMain.handle('brand:clear-session', async (_event, brandId: unknown) => {
  if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) return
  const ses = session.fromPartition(partitionFor(brandId))
  await ses.clearStorageData()
  await ses.clearCache()
})

void app.whenReady().then(() => {
  app.userAgentFallback = plainUserAgent()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
