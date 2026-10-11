import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { AccessLogEntry, AgentDraft, McpState, PostRequest } from './types'

// agent access lives in its own file so it never mixes with the brand data the ui saves
const MAX_LOG = 500
const MAX_ITEMS = 300

let state: McpState | null = null
let queue: Promise<void> = Promise.resolve()

function dir(): string {
  return join(app.getPath('userData'), 'mcp')
}

function file(): string {
  return join(dir(), 'state.json')
}

function empty(): McpState {
  return { grants: {}, log: [], drafts: [], posts: [] }
}

function clean(raw: unknown): McpState {
  const d = (raw ?? {}) as Partial<McpState>
  const grants: McpState['grants'] = {}
  for (const [brandId, ids] of Object.entries(d.grants ?? {})) {
    if (!ID_PATTERN.test(brandId) || !Array.isArray(ids)) continue
    grants[brandId] = ids.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id))
  }
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    grants,
    log: list<AccessLogEntry>(d.log).slice(-MAX_LOG),
    drafts: list<AgentDraft>(d.drafts).slice(-MAX_ITEMS),
    posts: list<PostRequest>(d.posts).slice(-MAX_ITEMS)
  }
}

export async function loadState(): Promise<McpState> {
  if (state) return state
  try {
    state = clean(JSON.parse(await fs.readFile(file(), 'utf8')))
  } catch {
    state = empty()
  }
  return state
}

export function notify(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('mcp:changed')
}

export async function changeState(fn: (s: McpState) => void): Promise<McpState> {
  const s = await loadState()
  fn(s)
  s.log = s.log.slice(-MAX_LOG)
  s.drafts = s.drafts.slice(-MAX_ITEMS)
  s.posts = s.posts.slice(-MAX_ITEMS)
  const text = JSON.stringify(s, null, 2)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${file()}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file())
  }
  queue = queue.then(run, run)
  await queue
  notify()
  return s
}

export function logEntry(entry: Omit<AccessLogEntry, 'id' | 'at'>): AccessLogEntry {
  return { id: randomUUID(), at: Date.now(), ...entry }
}

export async function addLog(entry: Omit<AccessLogEntry, 'id' | 'at'>): Promise<void> {
  await changeState((s) => s.log.push(logEntry(entry)))
}

export async function isGranted(brandId: string, siteId: string): Promise<boolean> {
  const s = await loadState()
  return s.grants[brandId]?.includes(siteId) ?? false
}

export async function setGrant(brandId: string, siteId: string, on: boolean): Promise<void> {
  if (!ID_PATTERN.test(brandId) || !ID_PATTERN.test(siteId)) return
  await changeState((s) => {
    const had = s.grants[brandId] ?? []
    const now = on ? [...new Set([...had, siteId])] : had.filter((id) => id !== siteId)
    if (now.length === had.length && had.includes(siteId) === on) return
    s.grants[brandId] = now
    s.log.push(logEntry({ brandId, siteId, kind: on ? 'grant' : 'revoke', detail: '' }))
  })
}

// deleting a brand drops its grants and queued stuff too
export async function forgetBrand(brandId: string): Promise<void> {
  await changeState((s) => {
    delete s.grants[brandId]
    s.drafts = s.drafts.filter((d) => d.brandId !== brandId)
    s.posts = s.posts.filter((p) => p.brandId !== brandId)
    s.log = s.log.filter((l) => l.brandId !== brandId)
  })
}
