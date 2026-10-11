import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'
import { ID_PATTERN, isHttpUrl, partitionFor, type AppData } from '@shared/types'
import { loadData, saveData } from './store'
import { dropTrends, setupTrends } from './trends'
import { attachBrand, blocksPopup, setupAdblock } from './adblock'
import { setupMcp } from './mcp'
import { forgetBrand } from './mcp/state'

const PARTITION_PREFIX = 'persist:brand-'

// some sites refuse to log in when the user agent says Electron
function plainUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${app.getName()}/\\S+`, 'i'), '')
}

const isMac = process.platform === 'darwin'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0E0E10',
    autoHideMenuBar: true,
    // our own title bar, mac keeps its traffic lights since people expect them there
    frame: isMac,
    titleBarStyle: isMac ? 'hidden' : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    title: 'TrendDeck',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => win.show())
  const sendMax = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

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
      return
    }
    attachBrand(partition.slice(PARTITION_PREFIX.length))
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  // a focused site eats key presses, so catch the brand shortcuts before it does
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift) return
    if (!/^[1-9]$/.test(input.key)) return
    event.preventDefault()
    contents.hostWebContents?.send('shortcut:brand', Number(input.key) - 1)
  })
  // login flows open popups, those stay in the same brand session
  contents.setWindowOpenHandler(({ url }) => {
    if (!isHttpUrl(url) || blocksPopup(contents, url)) return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
  })
})

ipcMain.handle('window:control', (event, action: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  } else if (action === 'close') win.close()
  return win.isMaximized()
})

ipcMain.handle('data:load', () => loadData())

ipcMain.handle('data:save', (_event, data: AppData) => saveData(data))

ipcMain.handle('brand:clear-session', async (_event, brandId: unknown) => {
  if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) return
  const ses = session.fromPartition(partitionFor(brandId))
  await ses.clearStorageData()
  await ses.clearCache()
  await dropTrends(brandId)
  await forgetBrand(brandId)
})

setupTrends()
setupMcp()

void app.whenReady().then(() => {
  app.userAgentFallback = plainUserAgent()
  // net.fetch needs the app ready, so the blocker starts here
  setupAdblock()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
