import { BrowserWindow, session, webContents, type WebContents } from 'electron'
import { partitionFor, type Brand, type Site } from '@shared/types'
import { isSiteShown } from '../hidden-sites'

// two-factor and one-time code boxes, agents can't read or type into these
const CODE_FIELD = `/otp|one.?time|2fa|two.?factor|verification.?code|security.?code|auth.?code|mfa|totp|passcode/i.test([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' '))`

// page scripts run in their own world so the site can't see or mess with them
const WORLD_ID = 1717

function bareHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// the most specific site of the brand whose host matches the url, subdomains count
export function siteForUrl(brand: Brand, url: string): Site | null {
  const host = bareHost(url)
  if (!host) return null
  let best: Site | null = null
  let bestLen = -1
  for (const site of brand.sites) {
    const h = bareHost(site.url)
    if (!h) continue
    if ((host === h || host.endsWith(`.${h}`)) && h.length > bestLen) {
      best = site
      bestLen = h.length
    }
  }
  return best
}

// site webviews in the app window that belong to this brand's session
export function brandTabs(brandId: string): WebContents[] {
  const ses = session.fromPartition(partitionFor(brandId))
  const hosts = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
  return webContents
    .getAllWebContents()
    .filter(
      (wc) =>
        !wc.isDestroyed() &&
        wc.getType() === 'webview' &&
        wc.session === ses &&
        wc.hostWebContents !== null &&
        hosts.has(wc.hostWebContents.id)
    )
}

// sites you left stay mounted and hidden, so the open tab is the one on screen
export function openTab(brandId: string): WebContents | null {
  return brandTabs(brandId).find((wc) => isSiteShown(wc.id)) ?? null
}

export async function waitForTab(brandId: string, siteHost: string, ms = 10000): Promise<WebContents | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const wc = openTab(brandId)
    if (wc && !wc.isLoading() && bareHost(wc.getURL()).endsWith(siteHost)) return wc
    await new Promise((r) => setTimeout(r, 250))
  }
  return openTab(brandId)
}

export async function waitIdle(wc: WebContents, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end && !wc.isDestroyed() && wc.isLoading()) {
    await new Promise((r) => setTimeout(r, 200))
  }
}

export function runInPage<T>(wc: WebContents, code: string): Promise<T> {
  return wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]) as Promise<T>
}

// builds the simple dom: numbered refs for things you can click or type into,
// text of the page, nothing from password fields, cookies or storage
const SNAPSHOT = `(() => {
  const refs = []
  window.__tdRefs = refs
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  const clip = (t, n) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, n)
  const secret = (el) => /password|hidden/.test(el.type || '') ||
    /cc-|password|one-time-code/.test(el.getAttribute('autocomplete') || '') || ${CODE_FIELD}
  // input values are never shown, only whether the box has something in it
  const value = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.type !== 'file' && el.value ? '(has text)' : ''
  const label = (el) =>
    clip(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
      el.getAttribute('alt') || el.innerText || '', 120)
  const pick = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=textbox],[contenteditable=""],[contenteditable=true]'
  const items = []
  for (const el of document.querySelectorAll(pick)) {
    const isFile = el.tagName === 'INPUT' && el.type === 'file'
    if (!isFile && !vis(el)) continue
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue
    if (items.length >= 400) break
    const ref = refs.push(el)
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role') || (el.isContentEditable ? 'textbox' : '')
    const type = tag === 'input' ? el.type : ''
    const parts = ['[' + ref + ']', role || tag]
    if (type && type !== 'text') parts.push('type=' + type)
    const l = label(el)
    if (l) parts.push(JSON.stringify(l))
    const v = clip(value(el), 200)
    if (v) parts.push(v)
    if (tag === 'a') parts.push('-> ' + clip(el.href, 160))
    if (secret(el)) parts.push('(private field, agents cannot type here)')
    if (el.disabled) parts.push('disabled')
    items.push(parts.join(' '))
  }
  const heads = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 40)
    .map((h) => h.tagName.toLowerCase() + ': ' + clip(h.innerText, 120))
  return {
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight },
    headings: heads,
    elements: items,
    text: clip(document.body ? document.body.innerText : '', 15000)
  }
})()`

export interface Snapshot {
  url: string
  title: string
  scroll: { y: number; height: number; view: number }
  headings: string[]
  elements: string[]
  text: string
}

export function snapshot(wc: WebContents): Promise<Snapshot> {
  return runInPage<Snapshot>(wc, SNAPSHOT)
}

// scrolls the ref into view and hands back where its middle is, or why not
export interface RefInfo {
  ok: boolean
  error?: string
  x?: number
  y?: number
  tag?: string
  type?: string
  editable?: boolean
  secret?: boolean
}

export function locate(wc: WebContents, ref: number): Promise<RefInfo> {
  return runInPage<RefInfo>(
    wc,
    `(() => {
      const el = (window.__tdRefs || [])[${Number(ref) - 1}]
      if (!el || !el.isConnected) return { ok: false, error: 'that ref is gone, read the page again' }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      const tag = el.tagName.toLowerCase()
      return {
        ok: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        tag,
        type: tag === 'input' ? el.type : '',
        secret: /password|hidden/.test(el.type || '') || /cc-|password|one-time-code/.test(el.getAttribute('autocomplete') || '') || ${CODE_FIELD},
        editable: tag === 'textarea' || el.isContentEditable || (tag === 'input' && !['button','submit','checkbox','radio','file','image','reset'].includes(el.type))
      }
    })()`
  )
}

export function focusRef(wc: WebContents, ref: number, clear: boolean): Promise<boolean> {
  return runInPage<boolean>(
    wc,
    `(() => {
      const el = (window.__tdRefs || [])[${Number(ref) - 1}]
      if (!el || !el.isConnected) return false
      el.focus()
      if (${clear ? 'true' : 'false'}) {
        if ('select' in el && typeof el.select === 'function') el.select()
        else if (el.isContentEditable) document.execCommand('selectAll')
      }
      return true
    })()`
  )
}

// tags the element so the devtools protocol can find it, then removes the tag
export async function markRef(wc: WebContents, ref: number, mark: string | null): Promise<boolean> {
  return runInPage<boolean>(
    wc,
    `(() => {
      const el = (window.__tdRefs || [])[${Number(ref) - 1}]
      if (!el) return false
      if (${JSON.stringify(mark)} === null) el.removeAttribute('data-td-upload')
      else el.setAttribute('data-td-upload', ${JSON.stringify(mark ?? '')})
      return el.tagName === 'INPUT' && el.type === 'file'
    })()`
  )
}

export async function click(wc: WebContents, x: number, y: number): Promise<void> {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

export function pressEnter(wc: WebContents): void {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

export function scrollPage(wc: WebContents, dy: number): Promise<{ y: number; height: number }> {
  return runInPage(
    wc,
    `(() => { window.scrollBy({ top: ${Math.round(dy)}, behavior: 'instant' }); return { y: Math.round(scrollY), height: document.documentElement.scrollHeight } })()`
  )
}
