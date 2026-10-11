import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'

// site tabs stay alive out of view. hidden ones get muted, their videos paused, and after a
// while frozen so they stop running scripts at all
const FREEZE_AFTER_MS = 5 * 60_000

const hidden = new Set<number>()
const frozen = new Set<number>()
const timers = new Map<number, NodeJS.Timeout>()

export function isSiteHidden(id: number): boolean {
  return hidden.has(id)
}

// uploads run in page scripts, a frozen page would stall them
function neverFreeze(url: string): boolean {
  try {
    const u = new URL(url)
    return /studio|upload/i.test(u.hostname + u.pathname)
  } catch {
    return true
  }
}

async function lifecycle(wc: WebContents, state: 'frozen' | 'active'): Promise<void> {
  // marked before the call, a frozen page may never answer it
  if (state === 'frozen') frozen.add(wc.id)
  else frozen.delete(wc.id)
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.setWebLifecycleState', { state })
  } catch {
    // devtools open on it or it's gone, leave it running
  }
}

function forget(id: number): void {
  hidden.delete(id)
  frozen.delete(id)
  clearTimeout(timers.get(id))
  timers.delete(id)
}

export function trackSite(wc: WebContents): void {
  const id = wc.id
  wc.once('destroyed', () => forget(id))
}

export function setupHiddenSites(onChange: (win: BrowserWindow) => void): void {
  ipcMain.on('site:hidden', (event, id: unknown, hide: unknown) => {
    if (typeof id !== 'number') return
    const wc = webContents.fromId(id)
    // only the app's own site tabs
    if (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== event.sender.id) return
    clearTimeout(timers.get(id))
    timers.delete(id)
    if (hide === true) {
      hidden.add(id)
      // a video you left keeps playing muted otherwise, and burns cpu for nothing
      void wc
        .executeJavaScript("document.querySelectorAll('video,audio').forEach((m) => m.pause())", false)
        .catch(() => {})
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          if (!wc.isDestroyed() && hidden.has(id) && !neverFreeze(wc.getURL())) void lifecycle(wc, 'frozen')
        }, FREEZE_AFTER_MS)
      )
    } else {
      hidden.delete(id)
      if (frozen.has(id)) void lifecycle(wc, 'active')
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) onChange(win)
  })
}
