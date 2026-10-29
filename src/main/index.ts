// first: a downloaded update links the installed app's native files before anything loads them
import './unpacked-link'
import { app, BrowserWindow, ipcMain, session, webContents, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupDictation } from './dictation'
import { setupObs } from './obs'
import { ID_PATTERN, isHttpUrl, partitionFor, type AppData } from '@shared/types'
import { styleSite } from './site-style'
import { setupUpdater, updateNow } from './updater'
import { setupContextMenu } from './context-menu'
import { setupPreviewSpeed } from './preview-speed'
import { moveProjectsOutOfOneDrive } from './craft/move-root'
import { webInUse } from './craft/web'
import { bootInfo } from './boot-state'
import { loadData, saveData } from './store'
import { dropTrends, setupTrends } from './trends'
import { attachBrand, blocksPopup, setupAdblock, startAdblock } from './adblock'
import { isSiteHidden, setupHiddenSites, trackSite } from './hidden-sites'
import { dropAnalytics, setupAnalytics } from './analytics'
import { dropPostingBrand, setupPosting } from './posting'
import { dropMedia, setupMedia } from './media'
import { setupMcp } from './mcp'
import { dropGatewayBrand, setupGateway } from './gateway'
import { forgetBrand } from './mcp/state'
import { forgetBrandLogins, setupVault } from './vault'
import { agentsWorking, dropChats, setupAgents, stopBrand } from './agents'
import { dropVoice, setupVoice } from './voice'
import { dropInboxBrand, setupInbox } from './inbox'
import { setupReuse } from './reuse'
import { dropBrandPhone, setupEmulator } from './emulator'
import { setupWorkspace } from './workspace'
import { craftHost, setupCraft } from './craft'
import { CRAFT_WEB_PARTITION, CRAFT_WEB_SCHEME } from '@shared/craft-web'
import { setupQc } from './qc'
import { dropCards, setupCards } from './cards'
import { dropStorageBrand, setupStorageSettings } from './production-storage'
import { dropContextBrand, setupContext } from './context'
import { dropMcpServersBrand, setupMcpServers } from './mcp-servers'
import { dropBrandMemory, setupVoiceScript } from './voice-script'
import { dropContentMap, setupContentMap } from './content-map'
import { dropVisualsBrand, setupVisuals } from './visuals'

const PARTITION_PREFIX = 'persist:brand-'
if (process.platform === 'win32') app.setAppUserModelId('com.joshwright.trenddeck')

// test runs pass --mute-audio or set TRENDDECK_MUTE=1 so nothing ever makes a sound
const MUTE_ALL = process.argv.includes('--mute-audio') || process.env.TRENDDECK_MUTE === '1'
if (MUTE_ALL) app.commandLine.appendSwitch('mute-audio')
// sites with a cast button make chromium look for tvs on the network, which opens a listening
// socket and the windows firewall prompt. trenddeck never casts
// test runs only: the window opens far off screen, never takes focus and stays off the taskbar,
// so screenshots over the debugging port don't pop up on the desktop. it keeps painting there, and
// the Craft apps docked over it still follow it
const offscreen = process.env.TRENDDECK_TEST_OFFSCREEN === '1'
app.commandLine.appendSwitch(
  'disable-features',
  // and a window another program covers isn't treated as hidden: it would stop drawing, and the
  // FilmCraft editor in the chat came back with its video at the wrong size for a moment after alt+tab
  'MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider,GlobalMediaControlsCastStartStop,CalculateNativeWinOcclusion'
)

// sites only play sound while you can see them
function syncMute(win: BrowserWindow): void {
  const hidden = !win.isVisible() || win.isMinimized()
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview' && wc.hostWebContents?.id === win.webContents.id) {
      wc.setAudioMuted(MUTE_ALL || hidden || isSiteHidden(wc.id))
    }
  }
}

// some sites refuse to log in when the user agent says Electron
function plainUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${app.getName()}/\\S+`, 'i'), '')
}

const isMac = process.platform === 'darwin'

// never the system browser, the renderer picks a site tab or makes a temporary one
function openInApp(host: WebContents | null | undefined, url: string): void {
  if (host && !host.isDestroyed() && isHttpUrl(url)) host.send('open:url', url)
}

// one TrendDeck at a time: opening it again brings up the one that's running. two would each run
// their own agents and editors on the same projects and write the same chat files
let mainWin: BrowserWindow | null = null
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', (_e, argv) => {
  if (!app.isReady()) return
  // a new release was just pushed: take it without bringing the window up
  if (argv.includes('--update-now')) return void updateNow(() => agentsWorking() || webInUse())
  if (!mainWin || mainWin.isDestroyed()) return createWindow()
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(offscreen ? { x: -10000, y: -10000, focusable: false, skipTaskbar: true } : {}),
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
      webviewTag: true,
      backgroundThrottling: !offscreen
    }
  })

  // craft apps dock over this window's workspace pane
  craftHost(win)

  mainWin = win
  win.once('ready-to-show', () => {
    // a downloaded update that got this far works, boot.ts keeps using it
    bootInfo()?.markGood()
    if (offscreen) win.showInactive()
    else win.show()
    // the ad blocker engine is big, give the first paint a head start
    setTimeout(startAdblock, 1000)
  })
  const sendMax = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)
  win.on('minimize', () => syncMute(win))
  win.on('restore', () => syncMute(win))
  win.on('hide', () => syncMute(win))
  win.on('show', () => syncMute(win))
  win.webContents.on('did-attach-webview', () => syncMute(win))

  // the app window only ever shows the app itself, links go to a site tab instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInApp(win.webContents, url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    openInApp(win.webContents, event.url)
  })

  // site tabs get no preload and no node, and must live in a brand partition. the Craft editors in
  // the chat live in their own partition on craft-web: with a preload that only passes dropped files on
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    const partition = params.partition ?? ''
    if (partition === CRAFT_WEB_PARTITION) {
      if (!(params.src ?? '').startsWith(`${CRAFT_WEB_SCHEME}://`)) event.preventDefault()
      webPreferences.preload = join(__dirname, '../preload/craft-web.js')
      webPreferences.backgroundThrottling = false
      delete params.allowpopups
      return
    }
    if (!partition.startsWith(PARTITION_PREFIX) || !isHttpUrl(params.src ?? '')) {
      event.preventDefault()
      return
    }
    attachBrand(partition.slice(PARTITION_PREFIX.length))
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    setupDictation(win, process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    setupDictation(win, pathToFileURL(join(__dirname, '../renderer/index.html')).href)
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win.webContents && permission === 'media' && details.isMainFrame)
  })
  win.webContents.session.setPermissionCheckHandler((contents, permission) => contents === win.webContents && permission === 'media')
}

app.on('web-contents-created', (_event, contents) => {
  if (MUTE_ALL) contents.setAudioMuted(true)
  if (contents.getType() !== 'webview') return
  trackSite(contents)
  styleSite(contents)
  // a focused site eats key presses, so catch the brand shortcuts before it does
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift) return
    if (!/^[1-9]$/.test(input.key)) return
    event.preventDefault()
    contents.hostWebContents?.send('shortcut:brand', Number(input.key) - 1)
  })
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!isHttpUrl(url) || blocksPopup(contents, url)) return { action: 'deny' }
    // a plain link that wants a new tab gets one inside the app
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      openInApp(contents.hostWebContents, url)
      return { action: 'deny' }
    }
    // sized popups are login flows, they need window.opener and stay in the same brand session
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
  await dropAnalytics(brandId)
  await dropPostingBrand(brandId)
  await dropMedia(brandId)
  await forgetBrand(brandId)
  await forgetBrandLogins(brandId)
  stopBrand(brandId)
  await dropChats(brandId)
  await dropVoice(brandId)
  await dropInboxBrand(brandId)
  await dropBrandPhone(brandId)
  await dropGatewayBrand(brandId)
  await dropCards(brandId)
  await dropStorageBrand(brandId)
  await dropContextBrand(brandId)
  await dropMcpServersBrand(brandId)
  await dropBrandMemory(brandId)
  await dropContentMap(brandId)
  await dropVisualsBrand(brandId)
})

setupContextMenu()
setupPreviewSpeed()
setupTrends()
setupAnalytics()
setupMcp()
setupGateway()
setupVault()
setupObs()
setupAgents()
setupVoice()
setupHiddenSites(syncMute)
setupInbox()
setupEmulator()
setupWorkspace()
setupCraft()
setupCards()
setupStorageSettings()
setupContext()
setupMcpServers()
setupVoiceScript()
setupContentMap()
setupVisuals()

void app.whenReady().then(async () => {
  app.userAgentFallback = plainUserAgent()
  // before anything opens a project: out of OneDrive, once
  await moveProjectsOutOfOneDrive().catch((err) => console.error('craft: moving the projects failed', err))
  // net.fetch needs the app ready, so the blocker hooks up here. its engine loads after first paint
  setupAdblock()
  setupPosting()
  setupMedia()
  setupReuse()
  setupQc()
  createWindow()
  void setupUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// what you type in the chat lives in the window's storage, which chromium writes to disk when it
// gets round to it. the window asks for it after you stop typing, and closing writes it too, so a
// draft survives the app closing or being stopped
ipcMain.on('drafts:flush', (e) => e.sender.session.flushStorageData())
app.on('before-quit', () => session.defaultSession.flushStorageData())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
