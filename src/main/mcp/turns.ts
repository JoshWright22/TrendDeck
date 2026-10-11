import { randomBytes, randomUUID } from 'node:crypto'
import { addLog, notify } from './state'

// a turn is one chat message being answered. the agent only gets in while one is open,
// with a token that dies when the turn ends
export interface Turn {
  id: string
  token: string
  brandId: string
  // site shared for just this message, on top of the grants in settings
  sharedSiteId: string | null
  startedAt: number
}

const turns = new Map<string, Turn>()
// the "share this tab" button arms this, the next turn for the brand takes it
let armed: { brandId: string; siteId: string } | null = null

// a turn left open by a crashed agent shouldn't keep the door open forever
const MAX_TURN_MS = 30 * 60_000

export function armShare(brandId: string, siteId: string): void {
  armed = { brandId, siteId }
}

export function disarmShare(): void {
  armed = null
}

export function armedShare(): { brandId: string; siteId: string } | null {
  return armed
}

export function openTurn(brandId: string, opts: { shareSiteId?: string | null } = {}): Turn {
  let shared = opts.shareSiteId ?? null
  if (!shared && armed?.brandId === brandId) shared = armed.siteId
  if (armed) {
    armed = null
    notify()
  }
  const turn: Turn = {
    id: randomUUID(),
    token: randomBytes(32).toString('hex'),
    brandId,
    sharedSiteId: shared,
    startedAt: Date.now()
  }
  turns.set(turn.id, turn)
  if (shared) void addLog({ brandId, siteId: shared, kind: 'share-once', detail: 'shared for one message' })
  return turn
}

export function closeTurn(id: string): void {
  turns.delete(id)
}

export function turnForToken(token: string): Turn | null {
  const now = Date.now()
  for (const t of turns.values()) {
    if (now - t.startedAt > MAX_TURN_MS) {
      turns.delete(t.id)
      continue
    }
    if (safeEqual(t.token, token)) return t
  }
  return null
}

export function anyOpen(): boolean {
  return turns.size > 0
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
