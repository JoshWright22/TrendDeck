import { BrowserWindow, type Session } from 'electron'

const TIMEOUT_MS = 20000

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// a hidden window on the brand's session, so the page sees the same logins as the brand's tabs.
// only ever opened from a refresh the user pressed
export function hiddenWindow(ses: Session): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

export async function open(win: BrowserWindow, url: string): Promise<void> {
  // some pages never fire load because of long polling, so cap the wait
  await Promise.race([win.loadURL(url).catch(() => {}), sleep(TIMEOUT_MS)])
}

// runs a small script in the page and hands back whatever it returns
export async function run<T>(win: BrowserWindow, code: string): Promise<T> {
  return (await win.webContents.executeJavaScript(code, true)) as T
}

// polls a script until it returns something truthy or time runs out
export async function waitFor<T>(win: BrowserWindow, code: string, ms = 12000): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (win.isDestroyed()) return null
    const got = await run<T>(win, code).catch(() => null)
    if (got) return got
    await sleep(500)
  }
  return null
}

export async function getJson<T>(ses: Session, url: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const host = new URL(url).hostname
  try {
    const res = await ses.fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) {
      // api errors usually say what's wrong, keep a short bit of it
      throw new Error(`${host} said ${res.status} ${text.slice(0, 140)}`.trim())
    }
    return JSON.parse(text) as T
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${host} timed out`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function getText(ses: Session, url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await ses.fetch(url, {
      signal: ctrl.signal,
      headers: { 'accept-language': 'en-US,en;q=0.9' }
    })
    if (!res.ok) throw new Error(`${new URL(url).hostname} said ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// "3 weeks ago" to a rough timestamp, good enough to sort and label posts
export function fromAgo(text: unknown, now = Date.now()): number | null {
  if (typeof text !== 'string') return null
  const m = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i)
  if (!m) return null
  const unit: Record<string, number> = {
    second: 1e3,
    minute: 6e4,
    hour: 36e5,
    day: 864e5,
    week: 6048e5,
    month: 2592e6,
    year: 31536e6
  }
  return now - Number(m[1]) * unit[m[2].toLowerCase()]
}
