import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { AuditEntry, AuditQuery } from '@shared/gateway'
import { broadcast } from './wait'

// one append only jsonl per brand: gateway/audit/<brand>.jsonl. when it passes MAX_BYTES it
// moves to <brand>.old.jsonl, so about two files' worth is kept
const MAX_BYTES = 4 * 1024 * 1024
const MAX_LIST = 500

function dir(): string {
  return join(app.getPath('userData'), 'gateway', 'audit')
}

const file = (brandId: string): string => join(dir(), `${brandId}.jsonl`)
const oldFile = (brandId: string): string => join(dir(), `${brandId}.old.jsonl`)

const queues = new Map<string, Promise<void>>()

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
  const full: AuditEntry = { id: randomUUID(), at: Date.now(), ...entry }
  broadcast('gateway:audit', full)
  if (!ID_PATTERN.test(entry.brandId)) return full
  const path = file(entry.brandId)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    const st = await fs.stat(path).catch(() => null)
    if (st && st.size > MAX_BYTES) await fs.rename(path, oldFile(entry.brandId)).catch(() => {})
    await fs.appendFile(path, `${JSON.stringify(full)}\n`, 'utf8')
  }
  const next = (queues.get(path) ?? Promise.resolve()).then(run, run).catch(() => {})
  queues.set(path, next)
  return full
}

async function readLines(path: string): Promise<AuditEntry[]> {
  const text = await fs.readFile(path, 'utf8').catch(() => '')
  const out: AuditEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as AuditEntry
      if (e && typeof e.id === 'string' && typeof e.tool === 'string') out.push(e)
    } catch {
      // a line cut off by a crash, skip it
    }
  }
  return out
}

// newest first
export async function listAudit(brandId: string, raw: unknown = {}): Promise<AuditEntry[]> {
  if (!ID_PATTERN.test(brandId)) return []
  const q = (raw ?? {}) as AuditQuery
  await queues.get(file(brandId))
  const limit = Math.min(MAX_LIST, Math.max(1, Math.round(Number(q.limit)) || 100))
  const before = Number(q.before) || Infinity
  const all = [...(await readLines(oldFile(brandId))), ...(await readLines(file(brandId)))]
  const out: AuditEntry[] = []
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i]
    if (e.at >= before) continue
    if (typeof q.tool === 'string' && q.tool && e.tool !== q.tool) continue
    if (typeof q.threadId === 'string' && q.threadId && e.threadId !== q.threadId) continue
    out.push(e)
  }
  return out
}

export async function dropAudit(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await queues.get(file(brandId))
  await fs.rm(file(brandId), { force: true })
  await fs.rm(oldFile(brandId), { force: true })
}
