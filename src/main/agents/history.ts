import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { Thread, ThreadMessage } from '@shared/chat'
import { getData } from '../store'

// one json per brand in chats/, the main process owns it so a reply that's still
// streaming gets saved even if the window moved on to another brand

const MAX_TEXT = 100_000

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
  if (m.role === 'agent') {
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

export async function removeThread(brandId: string, threadId: string): Promise<void> {
  const threads = await threadsFor(brandId)
  const i = threads.findIndex((t) => t.id === threadId)
  if (i >= 0) threads.splice(i, 1)
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
  loaded.delete(brandId)
  await (queues.get(brandId) ?? Promise.resolve()).catch(() => {})
  await fs.rm(file(brandId), { force: true })
}
