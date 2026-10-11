import {
  app,
  ipcMain,
  net,
  session,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OnBeforeRequestListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebContents
} from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
// the library is big, it gets loaded after the window has painted
import type { ElectronBlocker } from '@ghostery/adblocker-electron'
import { hostOf, ID_PATTERN, partitionFor } from '@shared/types'
import { getData } from './store'

// the lists uBlock Origin turns on by default, each with mirrors in case one is down
const UBO_CDN = [
  'https://ublockorigin.github.io/uAssetsCDN',
  'https://ublockorigin.pages.dev',
  'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main'
]
const LISTS: Record<string, string[]> = {
  'ublock-filters': UBO_CDN.map((b) => `${b}/filters/filters.min.txt`),
  'ublock-quick-fixes': UBO_CDN.map((b) => `${b}/filters/quick-fixes.min.txt`),
  'ublock-unbreak': UBO_CDN.map((b) => `${b}/filters/unbreak.min.txt`),
  'ublock-privacy': UBO_CDN.map((b) => `${b}/filters/privacy.min.txt`),
  'ublock-badware': UBO_CDN.map((b) => `${b}/filters/badware.min.txt`),
  easylist: [
    'https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt',
    ...UBO_CDN.slice(1).map((b) => `${b}/thirdparties/easylist.txt`),
    'https://easylist.to/easylist/easylist.txt'
  ],
  easyprivacy: [
    'https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt',
    ...UBO_CDN.slice(1).map((b) => `${b}/thirdparties/easyprivacy.txt`),
    'https://easylist.to/easylist/easyprivacy.txt'
  ]
}
// uBO's scriptlets (json-prune, set-constant and the rest) in the format the engine reads
const RESOURCES = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json',
  'https://cdn.jsdelivr.net/gh/ghostery/adblocker@master/packages/adblocker/assets/ublock-origin/resources.json'
]

const REFRESH_MS = 4 * 3600_000
const TIMEOUT_MS = 30_000
const ENGINE_FILE = 'engine.bin'

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

type Lib = typeof import('@ghostery/adblocker-electron')
let lib: Lib | null = null
let engine: ElectronBlocker | null = null
let refreshing = false
const brandOf = new WeakMap<Session, string>()
const attached = new Set<string>()

function dir(): string {
  return join(app.getPath('userData'), 'adblock')
}

function loginPage(url: string): boolean {
  try {
    const u = new URL(url)
    return ALLOW_HOSTS.has(u.hostname) || ALLOW_HOST_START.test(u.hostname) || ALLOW_PATH.test(u.pathname)
  } catch {
    return false
  }
}

// host matches an allowlist entry or is a subdomain of one
function allowlisted(list: string[], pageUrl: string): boolean {
  const host = hostOf(pageUrl)
  return !!host && list.some((d) => host === d || host.endsWith(`.${d}`))
}

// on unless the brand turned it off or the page is on its allowlist
export function blockingOn(brandId: string, pageUrl: string): boolean {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (!brand || !brand.adblock) return false
  return !loginPage(pageUrl) && !allowlisted(brand.adblockAllow, pageUrl)
}

// only pages inside site webviews and their popups, never the app's own trend fetches
function pageFor(wc: WebContents | null | undefined): string | null {
  if (!wc || wc.isDestroyed()) return null
  const type = wc.getType()
  if (type !== 'webview' && !(type === 'window' && wc.session !== session.defaultSession && wc.opener)) return null
  return wc.getURL()
}

function shouldBlock(brandId: string, wcId: number | undefined, url: string): boolean {
  if (!engine || wcId === undefined) return false
  const page = pageFor(webContents.fromId(wcId))
  if (page === null) return false
  return !loginPage(url) && blockingOn(brandId, page || url)
}

function onBeforeRequest(
  brandId: string,
  details: OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
): void {
  if (!engine || !shouldBlock(brandId, details.webContentsId, details.url)) return callback({})
  engine.onBeforeRequest(details, callback)
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
  const brandId = brandOf.get(opener.session)
  if (!engine || !lib || !brandId || !blockingOn(brandId, opener.getURL())) return false
  const request = lib.Request.fromRawDetails({ url, sourceUrl: opener.getURL(), type: 'other' })
  return engine.match(request).match
}

function cosmetics(url: string, injection: boolean, msg?: { classes?: string[]; hrefs?: string[]; ids?: string[] }) {
  if (!engine || !lib) return null
  const { hostname, domain } = lib.Request.fromRawDetails({ url })
  const first = msg === undefined
  return engine.getCosmeticsFilters({
    url,
    hostname,
    domain: domain || '',
    classes: msg?.classes,
    hrefs: msg?.hrefs,
    ids: msg?.ids,
    getBaseRules: first,
    getInjectionRules: injection,
    getExtendedRules: false,
    getRulesFromHostname: first,
    getRulesFromDOM: !first
  })
}

// hook a brand's session once, the hooks check the settings on every request
export function attachBrand(brandId: string): void {
  if (attached.has(brandId) || !ID_PATTERN.test(brandId)) return
  attached.add(brandId)
  const ses = session.fromPartition(partitionFor(brandId))
  brandOf.set(ses, brandId)
  ses.registerPreloadScript({ type: 'frame', filePath: join(__dirname, '../preload/adblock.js') })
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => onBeforeRequest(brandId, d, cb))
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => onHeadersReceived(brandId, d, cb))
}

async function fetchFirst(urls: string[]): Promise<string> {
  let last: unknown = null
  for (const url of urls) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await net.fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`${url} said ${res.status}`)
      const text = await res.text()
      if (text.length < 200) throw new Error(`${url} came back empty`)
      return text
    } catch (err) {
      last = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw last instanceof Error ? last : new Error('every mirror failed')
}

// fresh copy if we can get one, otherwise whatever we saved last time
async function getList(name: string, urls: string[]): Promise<string> {
  const file = join(dir(), `${name}.txt`)
  try {
    const text = await fetchFirst(urls)
    await fs.writeFile(file, text, 'utf8')
    return text
  } catch (err) {
    console.error(`adblock: ${name} failed to download`, err)
    return fs.readFile(file, 'utf8').catch(() => '')
  }
}

function build(lists: string[], resources: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'adblock-worker.js'))
    worker.once('message', (msg: { ok: boolean; engine?: Uint8Array; error?: string }) => {
      void worker.terminate()
      if (msg.ok && msg.engine) resolve(msg.engine)
      else reject(new Error(msg.error ?? 'adblock worker failed'))
    })
    worker.once('error', reject)
    worker.postMessage({ lists, resources })
  })
}

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    await fs.mkdir(dir(), { recursive: true })
    const [lists, resources] = await Promise.all([
      Promise.all(Object.entries(LISTS).map(([name, urls]) => getList(name, urls))),
      getList('resources', RESOURCES)
    ])
    if (lists.every((l) => !l)) return
    const bin = await build(lists, resources)
    lib ??= await import('@ghostery/adblocker-electron')
    engine = lib.ElectronBlocker.deserialize(bin)
    const file = join(dir(), ENGINE_FILE)
    await fs.writeFile(`${file}.tmp`, bin)
    await fs.rename(`${file}.tmp`, file)
  } catch (err) {
    console.error('adblock: refresh failed', err)
  } finally {
    refreshing = false
  }
}

// true when the cached engine is new enough to skip downloading the lists
async function loadCached(): Promise<boolean> {
  try {
    const file = join(dir(), ENGINE_FILE)
    const [buf, stat] = await Promise.all([fs.readFile(file), fs.stat(file)])
    lib ??= await import('@ghostery/adblocker-electron')
    // a fresh engine may have landed while this was reading
    engine ??= lib.ElectronBlocker.deserialize(new Uint8Array(buf))
    return Date.now() - stat.mtimeMs < REFRESH_MS
  } catch {
    // missing or from an older version, the refresh fixes both
    return false
  }
}

let started = false

// loads the cached engine, and only fetches and rebuilds the lists when they're old.
// called once the window has painted so none of it slows the start
export function startAdblock(): void {
  if (started) return
  started = true
  void loadCached().then((fresh) => {
    if (!fresh) void refresh()
  })
  setInterval(() => void refresh(), REFRESH_MS)
}

export function setupAdblock(): void {
  // the old prebuilt engine from before the switch to uBO's lists
  void fs.rm(join(app.getPath('userData'), 'adblock-engine.bin'), { force: true })

  // the preload asks for scriptlets before the page runs anything
  // returnValue sends the reply the moment it's set, so it only gets set once
  ipcMain.on('adblock:scripts', (event: IpcMainEvent, url: unknown) => {
    const brandId = brandOf.get(event.sender.session)
    const on =
      typeof url === 'string' && !!brandId && pageFor(event.sender) !== null && blockingOn(brandId, url)
    event.returnValue = on ? (cosmetics(url, true)?.scripts ?? []) : []
  })

  // the library's preload asks for element hiding css here, scripts already ran
  ipcMain.handle(
    '@ghostery/adblocker/inject-cosmetic-filters',
    (event: IpcMainInvokeEvent, url: unknown, msg?: { classes?: string[]; hrefs?: string[]; ids?: string[] }) => {
      const wc = event.sender
      const brandId = brandOf.get(wc.session)
      if (typeof url !== 'string' || !brandId || pageFor(wc) === null || !blockingOn(brandId, url)) return
      const result = cosmetics(url, false, msg)
      if (result?.active && result.styles.length > 0) {
        void wc.insertCSS(result.styles, { cssOrigin: 'user' }).catch(() => {})
      }
    }
  )
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => {
    // watching every dom change costs youtube about two seconds per load and stalls it while
    // it runs, the first pass of hiding rules plus the network and script rules cover the ads
    return false
  })
}
