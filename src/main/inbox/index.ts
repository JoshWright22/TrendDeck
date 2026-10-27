import { app, BrowserWindow, ipcMain, session, type Session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostOf, ID_PATTERN, isHttpUrl, partitionFor } from '@shared/types'
import { inboxSiteOf, type BrandInbox, type InboxComment, type InboxSite, type RefreshResult } from '@shared/inbox'
import { getData } from '../store'
import { checkHost, checkSites } from './health'
import { dropInbox, loadInbox, saveInbox } from './store'
import { cleanRaw, READERS, REPLY_STEPS } from './readers'

const validId = (id: unknown): id is string => typeof id === 'string' && ID_PATTERN.test(id)
const ses = (brandId: string): Session => session.fromPartition(partitionFor(brandId))

// test runs point this at a folder of saved pages (youtube.html, x.html, ...) so no real site is opened
const SAMPLES = process.env.TRENDDECK_INBOX_SAMPLES ?? ''

function send(brandId: string, inbox: BrandInbox): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('inbox:update', brandId, inbox)
}

async function checkBrand(brandId: string): Promise<BrandInbox> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  const inbox = await loadInbox(brandId)
  if (!brand) return inbox
  inbox.health = await checkSites(ses(brandId), brand.sites)
  await saveInbox(brandId, inbox)
  send(brandId, inbox)
  return inbox
}

// a site tab finished loading, recheck just that site
async function checkLoaded(sessionOf: Session, url: string): Promise<void> {
  const host = hostOf(url)
  if (!host) return
  for (const brand of getData()?.brands ?? []) {
    if (ses(brand.id) !== sessionOf) continue
    const sites = brand.sites.filter((s) => hostOf(s.url) === host)
    if (sites.length === 0) return
    const inbox = await loadInbox(brand.id)
    const state = await checkHost(sessionOf, host)
    let changed = false
    for (const s of sites) {
      if (inbox.health[s.id]?.state !== state) changed = true
      inbox.health[s.id] = { siteId: s.id, host, state, checkedAt: Date.now() }
    }
    await saveInbox(brand.id, inbox)
    if (changed) send(brand.id, inbox)
    return
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function hiddenWindow(brandId: string): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: partitionFor(brandId), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
}

async function readSite(brandId: string, site: InboxSite): Promise<unknown> {
  const reader = READERS[site]
  const win = hiddenWindow(brandId)
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    if (SAMPLES) {
      await win.loadURL(pathToFileURL(join(SAMPLES, `${site}.html`)).href)
    } else {
      await win.loadURL(reader.url)
      await wait(2500)
      const next = reader.then?.(win.webContents.getURL())
      if (reader.then) {
        if (!next) throw new Error('not logged in')
        await win.loadURL(next)
      }
      // these pages fill in with js after load
      await wait(4000)
    }
    return await win.webContents.executeJavaScript(reader.script, true)
  } finally {
    win.destroy()
  }
}

let refreshing = false

export async function refresh(brandId: string): Promise<RefreshResult[]> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (!brand || refreshing) return []
  refreshing = true
  try {
    const inbox = await checkBrand(brandId)
    const results: RefreshResult[] = []
    const fresh: InboxComment[] = []
    const known = new Map(inbox.comments.map((c) => [c.id, c]))
    // one read per site, the first logged in tab of that site names the account
    const done = new Set<InboxSite>()
    for (const s of brand.sites) {
      const site = inboxSiteOf(hostOf(s.url))
      if (!site || done.has(site)) continue
      done.add(site)
      if (!SAMPLES && inbox.health[s.id]?.state !== 'in') {
        results.push({ site, ok: false, count: 0, message: 'Not logged in' })
        continue
      }
      try {
        const list = cleanRaw(await readSite(brandId, site))
        for (const r of list) {
          const id = `${site}:${r.id}`
          const old = known.get(id)
          fresh.push({ ...r, id, site, account: s.name, read: old?.read ?? false, at: r.at || old?.at || Date.now() })
          known.delete(id)
        }
        results.push({ site, ok: true, count: list.length, message: list.length ? '' : 'Nothing found on the page' })
      } catch (err) {
        results.push({ site, ok: false, count: 0, message: err instanceof Error ? err.message : String(err) })
      }
    }
    // older comments we didn't see this time stay, newest first
    inbox.comments = [...fresh, ...known.values()].sort((a, b) => b.at - a.at)
    inbox.refreshedAt = Date.now()
    await saveInbox(brandId, inbox)
    send(brandId, inbox)
    return results
  } finally {
    refreshing = false
  }
}

async function findComment(brandId: string, id: string): Promise<InboxComment | null> {
  return (await loadInbox(brandId)).comments.find((c) => c.id === id) ?? null
}

// focus the reply box and type the text with real key input, the user presses the site's reply button
export async function reply(brandId: string, commentId: string, text: string): Promise<{ ok: boolean; message: string }> {
  const c = await findComment(brandId, commentId)
  if (!c || !isHttpUrl(c.url)) return { ok: false, message: 'That comment has no link to open' }
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    autoHideMenuBar: true,
    title: `Reply to ${c.author}`,
    webPreferences: { partition: partitionFor(brandId), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  await win.loadURL(c.url)
  await wait(3000)
  const steps = REPLY_STEPS[c.site]
  const js = (sels: string[], click: boolean): string => `(() => {
    for (const s of ${JSON.stringify(sels)}) {
      let el = null; try { el = document.querySelector(s) } catch {}
      if (el) { el.scrollIntoView({ block: 'center' }); ${click ? 'el.click()' : 'el.focus(); el.click()'}; return true }
    }
    return false
  })()`
  if (win.isDestroyed()) return { ok: false, message: 'Window closed' }
  if (steps.open.length) {
    await win.webContents.executeJavaScript(js(steps.open, true), true).catch(() => false)
    await wait(800)
  }
  const found = await win.webContents.executeJavaScript(js(steps.box, false), true).catch(() => false)
  if (!found) return { ok: false, message: 'Could not find the reply box, the window is open so you can paste it in' }
  await win.webContents.insertText(text)
  return { ok: true, message: 'Reply typed in, press Reply on the site to send it' }
}

async function openBlock(brandId: string, commentId: string): Promise<void> {
  const c = await findComment(brandId, commentId)
  if (!c || !isHttpUrl(c.authorUrl)) return
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: { partition: partitionFor(brandId), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  void win.loadURL(c.authorUrl)
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, max)).filter(Boolean))] : []

export async function dropInboxBrand(brandId: string): Promise<void> {
  await dropInbox(brandId)
}

export function setupInbox(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('did-finish-load', () => void checkLoaded(contents.session, contents.getURL()).catch(() => {}))
  })

  ipcMain.handle('inbox:load', (_e, brandId: unknown) => (validId(brandId) ? loadInbox(brandId) : null))
  ipcMain.handle('inbox:health', (_e, brandId: unknown) => (validId(brandId) ? checkBrand(brandId) : null))
  ipcMain.handle('inbox:refresh', (_e, brandId: unknown) => (validId(brandId) ? refresh(brandId) : []))
  ipcMain.handle('inbox:read', async (_e, brandId: unknown, ids: unknown, read: unknown) => {
    if (!validId(brandId)) return
    const want = new Set(strings(ids, 300))
    const inbox = await loadInbox(brandId)
    for (const c of inbox.comments) if (want.has(c.id)) c.read = read === true
    await saveInbox(brandId, inbox)
    send(brandId, inbox)
  })
  ipcMain.handle('inbox:blocked', async (_e, brandId: unknown, list: unknown) => {
    if (!validId(brandId)) return
    const inbox = await loadInbox(brandId)
    inbox.blocked = strings(list, 300).map((s) => s.toLowerCase())
    await saveInbox(brandId, inbox)
    send(brandId, inbox)
  })
  ipcMain.handle('inbox:keywords', async (_e, brandId: unknown, list: unknown) => {
    if (!validId(brandId)) return
    const inbox = await loadInbox(brandId)
    inbox.keywords = strings(list, 100)
    await saveInbox(brandId, inbox)
    send(brandId, inbox)
  })
  ipcMain.handle('inbox:reply', (_e, brandId: unknown, id: unknown, text: unknown) => {
    if (!validId(brandId) || typeof id !== 'string' || typeof text !== 'string' || !text.trim()) {
      return { ok: false, message: 'Nothing to send' }
    }
    return reply(brandId, id, text.slice(0, 10000))
  })
  ipcMain.handle('inbox:block-on-site', (_e, brandId: unknown, id: unknown) => {
    if (validId(brandId) && typeof id === 'string') return openBlock(brandId, id)
  })
}

