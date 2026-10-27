import { randomUUID } from 'node:crypto'
import type { ApprovalClosed, ApprovalRequest, ApprovalResponse } from '@shared/gateway'
import { broadcast, hasWindow, Waiters } from './wait'

export interface ApprovalOutcome {
  decision: ApprovalClosed['decision']
  note: string
  scope: 'once' | 'turn'
}

const waiters = new Waiters<ApprovalRequest, ApprovalOutcome>((id, reason) => {
  broadcast('gateway:approval-closed', { id, decision: reason as ApprovalClosed['decision'] } satisfies ApprovalClosed)
})

// tools the user said yes to for the rest of a turn
const allowedForTurn = new Map<string, Set<string>>()

export function turnAllowed(turnId: string): ReadonlySet<string> {
  return allowedForTurn.get(turnId) ?? new Set()
}

export async function requestApproval(
  input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>,
  timeoutSec: number
): Promise<ApprovalOutcome> {
  // nobody to ask, so the answer is no
  if (!hasWindow()) return { decision: 'cancelled', note: 'the app window is closed', scope: 'once' }
  const now = Date.now()
  const req: ApprovalRequest = { ...input, id: randomUUID(), createdAt: now, expiresAt: now + timeoutSec * 1000 }
  const wait = waiters.wait(req, req.turnId, timeoutSec * 1000, { decision: 'timeout', note: '', scope: 'once' })
  broadcast('gateway:approval-request', req)
  const out = await wait
  if (out.decision === 'approved' && out.scope === 'turn' && !req.alwaysAsk) {
    const set = allowedForTurn.get(req.turnId) ?? new Set<string>()
    set.add(req.tool)
    allowedForTurn.set(req.turnId, set)
  }
  return out
}

export function respondApproval(raw: unknown): boolean {
  const r = (raw ?? {}) as Partial<ApprovalResponse>
  if (typeof r.id !== 'string') return false
  const approve = r.approve === true
  return waiters.finish(
    r.id,
    {
      decision: approve ? 'approved' : 'denied',
      note: typeof r.note === 'string' ? r.note.slice(0, 500) : '',
      scope: r.scope === 'turn' ? 'turn' : 'once'
    },
    approve ? 'approved' : 'denied'
  )
}

export function pendingApprovals(): ApprovalRequest[] {
  return waiters.list()
}

export function dropTurnApprovals(turnId: string): void {
  for (const id of waiters.forTurn(turnId)) {
    waiters.finish(id, { decision: 'cancelled', note: 'the chat message ended', scope: 'once' }, 'cancelled')
  }
  allowedForTurn.delete(turnId)
}
