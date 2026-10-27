import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Site } from '@shared/types'
import type { LoginInput, LoginRequest } from '@shared/vault'
import type { Turn } from '../mcp/turns'
import { onTurnClosed } from '../mcp/turns'
import { getData } from '../store'
import { saveLogin } from './store'

interface Waiting {
  request: LoginRequest
  turnId: string
  resolve: (saved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

const waiting = new Map<string, Waiting>()

function changed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vault:login-requests-changed')
  }
}

function finish(id: string, saved: boolean): void {
  const pending = waiting.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  waiting.delete(id)
  pending.resolve(saved)
  changed()
}

export function loginRequests(): LoginRequest[] {
  return [...waiting.values()].map((pending) => pending.request)
}

export function requestLogin(turn: Turn, site: Site): Promise<boolean> {
  if ([...waiting.values()].some((pending) => pending.request.brandId === turn.brandId && pending.request.siteId === site.id)) {
    return Promise.resolve(false)
  }
  const id = randomUUID()
  const expiresAt = Date.now() + 5 * 60_000
  return new Promise((resolve) => {
    waiting.set(id, {
      request: { id, brandId: turn.brandId, threadId: turn.threadId, siteId: site.id, siteName: site.name, siteUrl: site.url, expiresAt },
      turnId: turn.id,
      resolve,
      timer: setTimeout(() => finish(id, false), expiresAt - Date.now())
    })
    changed()
  })
}

export async function answerLogin(id: string, input: LoginInput | null): Promise<string> {
  const pending = waiting.get(id)
  if (!pending || Date.now() >= pending.request.expiresAt) return 'This sign-in request has expired.'
  if (input === null) {
    finish(id, false)
    return ''
  }
  const { brandId, siteId, siteUrl } = pending.request
  const site = getData()?.brands.find((brand) => brand.id === brandId)?.sites.find((entry) => entry.id === siteId)
  if (!site || site.url !== siteUrl) {
    finish(id, false)
    return 'The website changed. Ask the agent to request sign-in again.'
  }
  try {
    const error = await saveLogin(brandId, siteId, input)
    if (error) return error
    if (!waiting.has(id)) return 'This sign-in request has ended.'
    finish(id, true)
    return ''
  } catch {
    return 'Could not save the sign-in securely. Try again.'
  }
}

export function setupLoginRequests(): void {
  onTurnClosed((turn) => {
    for (const [id, pending] of waiting) {
      if (pending.turnId === turn.id) finish(id, false)
    }
  })
  ipcMain.handle('vault:login-requests', (event) => event.sender.getType() === 'window' ? loginRequests() : [])
  ipcMain.handle('vault:answer-login', (event, id: unknown, raw: unknown) => {
    if (event.sender.getType() !== 'window' || typeof id !== 'string') return 'Invalid sign-in request.'
    if (raw === null) return answerLogin(id, null)
    if (!raw || typeof raw !== 'object') return 'Invalid sign-in input.'
    const input = raw as Partial<LoginInput>
    if (typeof input.username !== 'string' || typeof input.password !== 'string') return 'Enter a username and password.'
    return answerLogin(id, { username: input.username, password: input.password, notes: '', loginUrl: '' })
  })
}
