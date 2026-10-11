import { BrowserWindow, type Session } from 'electron'

const TIMEOUT_MS = 20000

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export async function getText(ses: Session, url: string, init: RequestInit = {}): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await ses.fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'accept-language': 'en-US,en;q=0.9', ...(init.headers ?? {}) }
    })
    const text = await res.text()
    if (!res.ok) throw new HttpError(res.status, `${new URL(url).hostname} said ${res.status}`)
    return text
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${new URL(url).hostname} timed out`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function getJson<T>(ses: Session, url: string, init: RequestInit = {}): Promise<T> {
  const text = await getText(ses, url, init)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(0, `${new URL(url).hostname} sent something that isn't json`)
  }
}

// some sites only answer once a real page has run its checks and set cookies,
// so load one in a hidden window on the same session and throw it away
export async function warmUp(ses: Session, url: string, settleMs = 4000): Promise<void> {
  const win = new BrowserWindow({
    show: false,
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
  try {
    await Promise.race([win.loadURL(url).catch(() => {}), sleep(15000)])
    await sleep(settleMs)
  } finally {
    win.destroy()
  }
}

export function compact(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
