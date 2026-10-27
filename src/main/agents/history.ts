import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { Attachment, Decision, Thread, ThreadMessage, WorkStep } from '@shared/chat'
import { isPermissionMode, type ApprovalRecord, type PlanStep, type QueuedMessage } from '@shared/providers'
import { getData } from '../store'

// one json per brand in chats/, the main process owns it so a reply that's still
// streaming gets saved even if the window moved on to another brand

const MAX_TEXT = 100_000

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function cleanAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).flatMap((a): Attachment[] => {
    const o = a as Partial<Attachment> | null
    if (!o || typeof o.name !== 'string') return []
    const file: Attachment = {
      id: str(o.id, 120) || o.name.slice(0, 120),
      name: o.name.slice(0, 200),
      type: str(o.type, 100),
      size: Number(o.size) || 0
    }
    if (o.media === true) file.media = true
    else if (o.visual === true) file.visual = true
    return [file]
  })
}

function cleanSteps(raw: unknown): WorkStep[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 200).flatMap((s): WorkStep[] => {
    const o = s as Partial<WorkStep> | null
    if (!o || typeof o.id !== 'string') return []
    return [
      {
        id: o.id.slice(0, 120),
        kind: o.kind ?? 'tool',
        label: str(o.label, 120),
        detail: str(o.detail, 300),
        // a step still running when the app closed didn't finish
        status: o.status === 'done' ? 'done' : 'error',
        startedAt: Number(o.startedAt) || 0,
        endedAt: Number(o.endedAt) || undefined
      }
    ]
  })
}

function cleanApprovals(raw: unknown): ApprovalRecord[] {
  if (!Array.isArray(raw)) return []
  const kinds = ['command', 'file-change', 'tool', 'web', 'other']
  return raw.slice(0, 100).flatMap((a): ApprovalRecord[] => {
    const o = a as Partial<ApprovalRecord> | null
    if (!o || typeof o.requestId !== 'string') return []
    const rec: ApprovalRecord = {
      requestId: o.requestId.slice(0, 120),
      kind: kinds.includes(o.kind as string) ? (o.kind as ApprovalRecord['kind']) : 'other',
      title: str(o.title, 200),
      detail: str(o.detail, 2100),
      canRemember: o.canRemember === true,
      at: Number(o.at) || 0,
      // a request still open when the app closed can't be answered anymore
      status: o.status === 'allowed' || o.status === 'denied' ? o.status : 'expired'
    }
    if (o.tool) rec.tool = str(o.tool, 200)
    if (o.reason) rec.reason = str(o.reason, 700)
    if (o.feedback) rec.feedback = str(o.feedback, 2000)
    return [rec]
  })
}

function cleanPlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 50).flatMap((p): PlanStep[] => {
    const o = p as Partial<PlanStep> | null
    if (!o || typeof o.text !== 'string') return []
    const status = o.status === 'done' || o.status === 'in-progress' ? o.status : 'pending'
    return [{ text: o.text.slice(0, 500), status }]
  })
}

function cleanQueue(raw: unknown): QueuedMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).flatMap((q): QueuedMessage[] => {
    const o = q as Partial<QueuedMessage> | null
    if (!o || typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.agentId !== 'string') return []
    return [{ id: o.id.slice(0, 120), text: o.text.slice(0, 8000), agentId: o.agentId.slice(0, 80), at: Number(o.at) || 0 }]
  })
}

function cleanMap<T extends string>(raw: unknown, ok: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) if (k.length < 120 && ok(v)) out[k] = v
  return out
}
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length < 300
const isDecision = (v: unknown): v is Decision => v === 'approved' || v === 'declined'

const loaded = new Map<string, Thread[]>()
const queues = new Map<string, Promise<void>>()

function dir(): string {
  return join(app.getPath('userData'), 'chats')
}

function file(brandId: string): string {
  return join(dir(), `${brandId}.json`)
}

function cleanMessage(raw: unknown): ThreadMessage | null {
  const m = raw as Partial<ThreadMessage> | null
  if (!m || typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return null
  if (m.role !== 'user' && m.role !== 'agent') return null
  if (typeof m.text !== 'string') return null
  const msg: ThreadMessage = { id: m.id, role: m.role, text: m.text.slice(0, MAX_TEXT), at: Number(m.at) || 0 }
  const files = cleanAttachments(m.attachments)
  if (files.length) msg.attachments = files
  if (m.role === 'user' && m.steer === true) msg.steer = true
  if (m.role === 'agent') {
    const approvals = cleanApprovals(m.approvals)
    if (approvals.length) msg.approvals = approvals
    const plan = cleanPlan(m.plan)
    if (plan.length) msg.plan = plan
    if (Array.isArray(m.handoffFrom)) msg.handoffFrom = m.handoffFrom.filter(isStr).slice(0, 10)
    if (Array.isArray(m.skipped)) {
      const skipped = m.skipped
        .filter((s) => s && isStr(s.agentId) && (s.reason === 'rate_limit' || s.reason === 'usage_limit' || s.reason === 'auth'))
        .slice(0, 20)
        .map((s) => ({ agentId: s.agentId.slice(0, 80), reason: s.reason }))
      if (skipped.length) msg.skipped = skipped
    }
    if (m.model) msg.model = str(m.model, 120)
    if (m.thinking) msg.thinking = str(m.thinking, MAX_TEXT)
    if (m.thinkingTokens) msg.thinkingTokens = Number(m.thinkingTokens) || 0
    const steps = cleanSteps(m.steps)
    if (steps.length) msg.steps = steps
    if (m.contextTokens) msg.contextTokens = Number(m.contextTokens) || 0
    if (m.finishedAt) msg.finishedAt = Number(m.finishedAt) || 0
    if (m.decisions) msg.decisions = cleanMap(m.decisions, isDecision)
    msg.agentId = typeof m.agentId === 'string' ? m.agentId.slice(0, 80) : undefined
    // a reply that was streaming when the app closed is as far as it got
    msg.status = m.status === 'error' ? 'error' : m.status === 'done' ? 'done' : 'stopped'
    if (typeof m.error === 'string') msg.error = m.error.slice(0, 2000)
  }
  return msg
}

function cleanThread(raw: unknown): Thread | null {
  const t = raw as Partial<Thread> | null
  if (!t || typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) return null
  const messages = Array.isArray(t.messages)
    ? t.messages.map(cleanMessage).filter((m): m is ThreadMessage => m !== null)
    : []
  return {
    id: t.id,
    title: typeof t.title === 'string' ? t.title.slice(0, 80) : 'New chat',
    updatedAt: Number(t.updatedAt) || 0,
    agentId: typeof t.agentId === 'string' ? t.agentId.slice(0, 80) : null,
    models: cleanMap(t.models, isStr),
    efforts: cleanMap(t.efforts, isStr),
    sessions: cleanMap(t.sessions, isStr),
    voiceSent: cleanMap(t.voiceSent, isStr),
    archived: t.archived === true,
    permissionMode: isPermissionMode(t.permissionMode) ? t.permissionMode : undefined,
    queued: cleanQueue(t.queued),
    seen: cleanMap(t.seen, isStr),
    messages
  }
}

// chats saved before this file existed sit on the brand in trenddeck.json
function legacy(brandId: string): Thread[] {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  return (brand?.threads ?? []).flatMap((t) => {
    const thread = cleanThread({ ...t, agentId: null })
    if (!thread) return []
    thread.messages = thread.messages.map((m) => (m.role === 'agent' ? { ...m, status: 'done' } : m))
    return [thread]
  })
}

export async function threadsFor(brandId: string): Promise<Thread[]> {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
  const hit = loaded.get(brandId)
  if (hit) return hit
  let threads: Thread[]
  try {
    const raw = JSON.parse(await fs.readFile(file(brandId), 'utf8')) as { threads?: unknown }
    threads = Array.isArray(raw.threads)
      ? raw.threads.map(cleanThread).filter((t): t is Thread => t !== null)
      : []
  } catch {
    threads = legacy(brandId)
  }
  // something else may have loaded it while we were reading
  const again = loaded.get(brandId)
  if (again) return again
  loaded.set(brandId, threads)
  return threads
}

export async function findThread(brandId: string, threadId: string): Promise<Thread | null> {
  return (await threadsFor(brandId)).find((t) => t.id === threadId) ?? null
}

export async function addThread(brandId: string, thread: Thread): Promise<void> {
  ;(await threadsFor(brandId)).push(thread)
}

// a deleted chat is copied to chats/removed/ first, one line per chat, so nothing you wrote is lost
async function keepRemoved(brandId: string, threads: Thread[]): Promise<void> {
  if (!threads.length) return
  const at = Date.now()
  const lines = threads.map((t) => JSON.stringify({ removedAt: at, thread: t }) + '\n').join('')
  await fs.mkdir(join(dir(), 'removed'), { recursive: true })
  await fs.appendFile(join(dir(), 'removed', `${brandId}.jsonl`), lines, 'utf8')
}

export async function removeThread(brandId: string, threadId: string): Promise<void> {
  const threads = await threadsFor(brandId)
  const i = threads.findIndex((t) => t.id === threadId)
  if (i >= 0) {
    await keepRemoved(brandId, [threads[i]])
    const current = threads.findIndex((thread) => thread.id === threadId)
    if (current >= 0) threads.splice(current, 1)
  }
  await persist(brandId)
}

// queued per brand, through a temp file so a crash can't leave half a file
export function persist(brandId: string): Promise<void> {
  const run = async (): Promise<void> => {
    const threads = loaded.get(brandId)
    if (!threads) return
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${file(brandId)}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, threads }), 'utf8')
    await fs.rename(tmp, file(brandId))
  }
  const next = (queues.get(brandId) ?? Promise.resolve()).then(run, run)
  queues.set(brandId, next)
  return next
}

export async function dropChats(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await (queues.get(brandId) ?? Promise.resolve()).catch(() => {})
  await keepRemoved(brandId, await threadsFor(brandId))
  await fs.rm(file(brandId), { force: true })
  loaded.delete(brandId)
}
