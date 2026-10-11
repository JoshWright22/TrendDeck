import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  session,
  webContents,
  type IpcMainInvokeEvent,
  type OnBeforeRequestListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebContents
} from 'electron'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ElectronBlocker, Request } from '@ghostery/adblocker-electron'
import { ID_PATTERN, partitionFor, type AdblockCount } from '@shared/types'
import { getData } from './store'

const REFRESH_MS = 24 * 3600_000
const ENGINE_FILE = 'adblock-engine.bin'

// never touch these, they're where you log in or run your channel
const ALLOW_HOSTS = new Set([
  'studio.youtube.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'login.live.com',
  'login.microsoftonline.com',
  'accounts.snapchat.com'
])
const ALLOW_HOST_START = /^(login|auth|signin|sso|accounts?|id)\./i
const ALLOW_PATH = /^\/(i\/flow\/login|accounts\/login|login|signin|sign-in|sign_in|auth|oauth|account\/login|session)\b/i

let engine: ElectronBlocker | null = null
let refreshing = false

// which brand and site a webview belongs to, the renderer tells us when it attaches
const views = new Map<number, { brandId: string; siteId: string }>()
// unique urls blocked on the page that's open, some ad scripts retry a blocked url
// hundreds of times a second and counting every try would make the number useless
const pageBlocked = new Map<number, Set<string>>()
const MAX_TRACKED = 5000
const brandTotals = new Map<string, number>()
const attached = new Set<string>()

function enginePath(): string {
  return join(app.getPath('userData'), ENGINE_FILE)
}

function allowed(url: string): boolean {
  try {
    const u = new URL(url)
    return ALLOW_HOSTS.has(u.hostname) || ALLOW_HOST_START.test(u.hostname) || ALLOW_PATH.test(u.pathname)
  } catch {
    return false
  }
}

function settingOn(brandId: string, siteId: string | undefined): boolean {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (!brand || brand.adblock === false) return false
  const site = siteId ? brand.sites.find((s) => s.id === siteId) : undefined
  return site?.adblock !== false
}

// only pages inside site webviews get blocked, never the app's own trend fetches
function shouldBlock(brandId: string, wcId: number | undefined, url: string): boolean {
  if (!engine || wcId === undefined) return false
  const wc = webContents.fromId(wcId)
  if (!wc || wc.getType() !== 'webview') return false
  if (!settingOn(brandId, views.get(wcId)?.siteId)) return false
  const page = wc.getURL()
  return !allowed(url) && !(page && allowed(page))
}

let pushTimer: NodeJS.Timeout | null = null
const dirty = new Set<number>()

// counts can tick hundreds of times a second, so batch them
function bump(brandId: string, wcId: number, url: string): void {
  let seen = pageBlocked.get(wcId)
  if (!seen) pageBlocked.set(wcId, (seen = new Set()))
  if (seen.has(url) || seen.size >= MAX_TRACKED) return
  seen.add(url)
  brandTotals.set(brandId, (brandTotals.get(brandId) ?? 0) + 1)
  dirty.add(wcId)
  if (!pushTimer) pushTimer = setTimeout(flush, 250)
}

function flush(): void {
  pushTimer = null
  for (const wcId of dirty) send(wcId)
  dirty.clear()
}

function send(wcId: number): void {
  const view = views.get(wcId)
  if (!view) return
  const msg: AdblockCount = {
    webContentsId: wcId,
    count: pageBlocked.get(wcId)?.size ?? 0,
    brandId: view.brandId,
    brandTotal: brandTotals.get(view.brandId) ?? 0
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('adblock:count', msg)
}

function onBeforeRequest(
  brandId: string,
  details: OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
): void {
  if (!engine || !shouldBlock(brandId, details.webContentsId, details.url)) return callback({})
  engine.onBeforeRequest(details, (response) => {
    if ((response.cancel || response.redirectURL) && details.webContentsId !== undefined) {
      bump(brandId, details.webContentsId, details.url)
    }
    callback(response)
  })
}

function onHeadersReceived(
  brandId: string,
  details: OnHeadersReceivedListenerDetails,
  callback: (response: Electron.HeadersReceivedResponse) => void
): void {
  if (!engine || !shouldBlock(brandId, details.webContentsId, details.url)) return callback({})
  engine.onHeadersReceived(details, callback)
}

// popups from a site, e.g. the ad tab that opens when you click anywhere.
// the lists have no popup type, so check the url as a plain request
export function blocksPopup(opener: WebContents, url: string): boolean {
  const view = views.get(opener.id)
  if (!engine || !view || !shouldBlock(view.brandId, opener.id, url)) return false
  const request = Request.fromRawDetails({ url, sourceUrl: opener.getURL(), type: 'other' })
  if (!engine.match(request).match) return false
  bump(view.brandId, opener.id, url)
  return true
}

// ghostery runs scriptlets with executeJavaScript and doesn't catch the promise,
// so a page that throws would spam unhandled rejections
function quietSender(wc: WebContents): WebContents {
  return new Proxy(wc, {
    get(target, prop) {
      if (prop === 'executeJavaScript') {
        return (code: string, gesture?: boolean) =>
          target.executeJavaScript(code, gesture).catch(() => undefined)
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

const preloadPath = createRequire(__filename).resolve('@ghostery/adblocker-electron-preload')

// hook a brand's session once, the hooks check the toggles on every request
export function attachBrand(brandId: string): void {
  if (attached.has(brandId) || !ID_PATTERN.test(brandId)) return
  attached.add(brandId)
  const ses: Session = session.fromPartition(partitionFor(brandId))
  ses.registerPreloadScript({ type: 'frame', filePath: preloadPath })
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => onBeforeRequest(brandId, d, cb))
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => onHeadersReceived(brandId, d, cb))
}

async function loadCached(): Promise<number> {
  try {
    const [buf, stat] = await Promise.all([fs.readFile(enginePath()), fs.stat(enginePath())])
    engine = ElectronBlocker.deserialize(new Uint8Array(buf))
    return stat.mtimeMs
  } catch {
    // missing or from an older version, a fresh download fixes both
    return 0
  }
}

async function download(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking((url: string) => net.fetch(url))
    engine = fresh
    const tmp = `${enginePath()}.tmp`
    await fs.writeFile(tmp, fresh.serialize())
    await fs.rename(tmp, enginePath())
  } catch (err) {
    console.error('adblock lists failed to download', err)
  } finally {
    refreshing = false
  }
}

export function setupAdblock(): void {
  void loadCached().then((savedAt) => {
    if (Date.now() - savedAt > REFRESH_MS) void download()
  })
  setInterval(() => void download(), REFRESH_MS)

  // the preload in each page asks for cosmetic filters through these
  ipcMain.handle(
    '@ghostery/adblocker/inject-cosmetic-filters',
    (event: IpcMainInvokeEvent, url: string, msg?: unknown) => {
      const wc = event.sender
      const view = views.get(wc.id)
      if (!engine || wc.getType() !== 'webview' || !view) return
      if (!settingOn(view.brandId, view.siteId) || allowed(url) || allowed(wc.getURL())) return
      const quiet = Object.assign(Object.create(event), { sender: quietSender(wc) })
      return engine.onInjectCosmeticFilters(quiet, url, msg as never)
    }
  )
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => {
    return engine?.config.enableMutationObserver ?? false
  })

  ipcMain.handle('adblock:attach', (event, wcId: unknown, brandId: unknown, siteId: unknown) => {
    if (typeof wcId !== 'number' || typeof brandId !== 'string' || typeof siteId !== 'string') return
    const wc = webContents.fromId(wcId)
    // only the app window may claim its own webviews
    if (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== event.sender.id) return
    if (views.has(wcId)) return send(wcId)
    views.set(wcId, { brandId, siteId })
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      pageBlocked.delete(wcId)
      send(wcId)
    })
    wc.once('destroyed', () => {
      views.delete(wcId)
      pageBlocked.delete(wcId)
    })
    send(wcId)
  })
}
