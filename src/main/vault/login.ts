import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Brand, Site } from '@shared/types'
import type { LoginResult } from '@shared/vault'
import { getData } from '../store'
import { openTab, siteForUrl, waitForTab, waitIdle } from '../mcp/tabs'
import { isAuthUrl, probe, setLoginBusy, type Probe } from './guard'
import { loginUrlFor, logAttempt, readSecret } from './store'

const WORLD_ID = 1717
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// sign-in pages for the default sites. extra hosts are where the form lives when it's not the site itself
const KNOWN: { host: string; url: string; extra?: string[] }[] = [
  { host: 'reddit.com', url: 'https://www.reddit.com/login/' },
  { host: 'x.com', url: 'https://x.com/i/flow/login' },
  { host: 'twitter.com', url: 'https://x.com/i/flow/login', extra: ['x.com'] },
  { host: 'instagram.com', url: 'https://www.instagram.com/accounts/login/' },
  { host: 'tiktok.com', url: 'https://www.tiktok.com/login/phone-or-email/email' },
  {
    host: 'studio.youtube.com',
    url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fstudio.youtube.com%2F',
    extra: ['accounts.google.com']
  },
  {
    host: 'youtube.com',
    url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
    extra: ['accounts.google.com']
  }
]

function plan(site: Site, saved: string): { url: string; hosts: string[] } {
  const siteHost = host(site.url)
  const known = KNOWN.find((k) => siteHost === k.host || siteHost.endsWith(`.${k.host}`))
  const url = saved || known?.url || site.url
  const hosts = [siteHost, ...(known?.extra ?? [])]
  // a sign-in page the user typed in is trusted for filling too
  if (saved) hosts.push(host(saved))
  return { url, hosts }
}

function onHost(url: string, hosts: string[]): boolean {
  const h = host(url)
  return hosts.some((x) => h === x || h.endsWith(`.${x}`))
}

// clicks the middle of a stored field, focuses it and selects what's in it
async function focusField(wc: WebContents, which: 'user' | 'pass' | 'code', index = 0): Promise<boolean> {
  const at = (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    {
      code: `(() => {
        const f = (window.__tdLogin || {})[${JSON.stringify(which)}]
        const el = Array.isArray(f) ? f[${index}] : f
        if (!el || !el.isConnected) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    }
  ])) as { x: number; y: number } | null
  if (!at) return false
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(120)
  return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    {
      code: `(() => {
        const f = (window.__tdLogin || {})[${JSON.stringify(which)}]
        const el = Array.isArray(f) ? f[${index}] : f
        if (!el || !el.isConnected) return false
        el.focus()
        el.select && el.select()
        return document.activeElement === el
      })()`
    }
  ])) as boolean
}

// how many characters the field holds now, so we know the typing landed. never the value itself
async function fieldLength(wc: WebContents, which: 'user' | 'pass'): Promise<number> {
  return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    { code: `(() => { const el = (window.__tdLogin || {})[${JSON.stringify(which)}]; return el ? el.value.length : -1 })()` }
  ])) as number
}

// real key input so sites that check for a person still take it. the text goes from here
// straight into the page, it never touches an agent or a log
async function fill(wc: WebContents, which: 'user' | 'pass', value: string): Promise<boolean> {
  for (let tries = 0; tries < 2; tries++) {
    if (!(await focusField(wc, which))) return false
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await wc.insertText(value)
    await sleep(150)
    if ((await fieldLength(wc, which)) === value.length) return true
  }
  // some username boxes format what you type, like phone numbers
  return which === 'user'
}

async function typeCode(wc: WebContents, code: string, boxes: number): Promise<boolean> {
  if (boxes > 1) {
    for (let i = 0; i < Math.min(boxes, code.length); i++) {
      if (!(await focusField(wc, 'code', i))) return false
      await wc.insertText(code[i])
      await sleep(60)
    }
    return true
  }
  if (!(await focusField(wc, 'code'))) return false
  await wc.insertText(code)
  return true
}

const SUBMIT = /^(log ?in|sign ?in|next|continue|submit|verify|confirm|done|log on|sign on)$/i

// clicks the form's submit button, or presses Enter in the field if there isn't one
async function submit(wc: WebContents, from: 'user' | 'pass' | 'code'): Promise<void> {
  await sleep(300)
  const at = (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    {
      code: `(() => {
        const f = (window.__tdLogin || {})[${JSON.stringify(from)}]
        const field = Array.isArray(f) ? f[f.length - 1] : f
        const ok = (b) => b && b.isConnected && !b.disabled && b.getBoundingClientRect().width > 0
        const scope = (field && field.form) || document
        let btn = [...scope.querySelectorAll('button[type=submit],input[type=submit]')].find(ok)
        if (!btn) {
          const re = ${SUBMIT.toString()}
          btn = [...document.querySelectorAll('button,[role=button],input[type=button]')]
            .find((b) => ok(b) && re.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim()))
        }
        if (!btn) return null
        btn.scrollIntoView({ block: 'center' })
        const r = btn.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    }
  ])) as { x: number; y: number } | null
  if (at) {
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  } else {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }
}

// when the sign-in page shows no form, try its "log in" or "use email" link once
async function clickSignInLink(wc: WebContents): Promise<boolean> {
  const at = (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    {
      code: `(() => {
        const re = /^(log ?in|sign ?in|use (email|username|phone)|continue with (email|username|phone)|(log|sign) in with (email|username|password))/i
        const el = [...document.querySelectorAll('a,button,[role=button]')].find((b) => {
          const r = b.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && re.test((b.innerText || b.getAttribute('aria-label') || '').trim())
        })
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    }
  ])) as { x: number; y: number } | null
  if (!at) return false
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}

const sig = (p: Probe | null): string => (p ? `${p.url}|${p.user}|${p.pass}|${p.code}|${p.captcha}|${p.alert}` : 'none')
const anything = (p: Probe | null): boolean => !!p && (p.user || p.pass || p.code > 0 || p.captcha)

// waits for the page to settle into something we can act on. returns the last look
async function look(wc: WebContents, ms: number, before = ''): Promise<Probe | null> {
  const end = Date.now() + ms
  let last: Probe | null = null
  while (Date.now() < end && !wc.isDestroyed()) {
    await waitIdle(wc, Math.max(500, end - Date.now()))
    last = await probe(wc)
    if (last && sig(last) !== before && (anything(last) || !isAuthUrl(last.url))) {
      // give single page apps a moment to finish drawing
      await sleep(500)
      return (await probe(wc)) ?? last
    }
    await sleep(400)
  }
  return last
}

// two-factor codes: the app asks the user in its own dialog, the code goes from there into the page
const waiting = new Map<string, (code: string | null) => void>()

export function setupCodePrompt(): void {
  ipcMain.handle('vault:code', (event, id: unknown, code: unknown) => {
    if (event.sender.getType() !== 'window' || typeof id !== 'string') return
    const done = waiting.get(id)
    if (!done) return
    waiting.delete(id)
    const clean = typeof code === 'string' ? code.replace(/[\s-]/g, '') : ''
    done(/^[A-Za-z0-9]{4,12}$/.test(clean) ? clean : null)
  })
}

function askCode(brandId: string, siteName: string): Promise<string | null> {
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      resolve(null)
    }, 3 * 60_000)
    waiting.set(id, (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.flashFrame(true)
      win.webContents.send('vault:ask-code', { id, brandId, siteName })
    }
  })
}

async function openSignIn(brand: Brand, site: Site, url: string): Promise<WebContents | null> {
  let wc = openTab(brand.id)
  if (!wc || siteForUrl(brand, wc.getURL())?.id !== site.id) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('mcp:open-site', { brandId: brand.id, siteId: site.id, url: site.url })
    }
    wc = await waitForTab(brand.id, host(site.url))
  }
  if (!wc) return null
  await wc.loadURL(url).catch(() => {})
  await waitIdle(wc, 15000)
  return wc
}

async function run(brand: Brand, site: Site): Promise<LoginResult> {
  const secret = await readSecret(brand.id, site.id)
  if (!secret) return 'no_saved_login'
  if (getData()?.activeBrandId !== brand.id) return 'needs_user'
  const { url, hosts } = plan(site, await loginUrlFor(brand.id, site.id))
  const wc = await openSignIn(brand, site, url)
  if (!wc) return 'failed'

  let userSent = false
  let passSent = false
  let codeSent = false
  let linkTried = false
  let before = ''
  for (let step = 0; step < 8; step++) {
    const p = await look(wc, step === 0 ? 10000 : 15000, before)
    if (!p || wc.isDestroyed()) return 'failed'
    before = sig(p)
    // never type a saved login anywhere but the site or its own sign-in host
    if (!onHost(p.url, hosts)) return passSent ? 'needs_user' : 'failed'
    if (p.captcha) return 'needs_user'

    if (p.code > 0) {
      if (codeSent) return p.alert ? 'failed' : 'needs_user'
      const code = await askCode(brand.id, site.name)
      if (!code) return 'needs_code'
      if (!(await typeCode(wc, code, p.code))) return 'needs_user'
      await submit(wc, 'code')
      codeSent = true
      continue
    }

    if (p.pass) {
      // the password box is back after we sent it, so it was wrong
      if (passSent) return 'failed'
      // a sign-up or change password page has two password boxes, that's not ours to fill
      if (p.passCount > 1) return 'needs_user'
      if (p.user && !(await fill(wc, 'user', secret.username))) return 'failed'
      if (!(await fill(wc, 'pass', secret.password))) return 'failed'
      await submit(wc, 'pass')
      passSent = true
      continue
    }

    if (p.user) {
      if (userSent) return p.alert ? 'failed' : 'needs_user'
      if (!(await fill(wc, 'user', secret.username))) return 'failed'
      await submit(wc, 'user')
      userSent = true
      continue
    }

    // no form on screen
    if (passSent || codeSent) return isAuthUrl(p.url) ? 'needs_user' : 'logged_in'
    if (userSent) return 'needs_user'
    // logged in sites usually bounce the sign-in page to home. a "log in" link still on screen means not
    if (!linkTried && (await clickSignInLink(wc))) {
      linkTried = true
      continue
    }
    return isAuthUrl(p.url) ? 'needs_user' : 'already_logged_in'
  }
  return 'needs_user'
}

// one login attempt, start to finish. only ever hands back the result
export async function login(brand: Brand, site: Site): Promise<LoginResult> {
  setLoginBusy(brand.id, true)
  let result: LoginResult = 'failed'
  try {
    result = await run(brand, site)
  } catch {
    result = 'failed'
  } finally {
    setLoginBusy(brand.id, false)
  }
  await logAttempt(brand.id, site.id, result).catch(() => {})
  return result
}
