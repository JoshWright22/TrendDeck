import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { ReplyDraft } from '@shared/gateway'
import { dataChanged } from './tools/common'

// replies an agent drafted for inbox comments, gateway/replies/<brand>.json.
// one draft per comment, a new one replaces the old
const MAX = 500

const dir = (): string => join(app.getPath('userData'), 'gateway', 'replies')
const file = (brandId: string): string => join(dir(), `${brandId}.json`)

const queues = new Map<string, Promise<unknown>>()

function clean(raw: unknown): ReplyDraft[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((d): d is ReplyDraft => !!d && typeof d.id === 'string' && typeof d.commentId === 'string' && typeof d.text === 'string')
    .map((d) => ({ id: d.id, commentId: d.commentId, text: d.text.slice(0, 10000), at: Number(d.at) || 0, sentAt: Number(d.sentAt) || 0 }))
}

export async function listReplyDrafts(brandId: string): Promise<ReplyDraft[]> {
  if (!ID_PATTERN.test(brandId)) return []
  await queues.get(brandId)
  try {
    return clean(JSON.parse(await fs.readFile(file(brandId), 'utf8')))
  } catch {
    return []
  }
}

function change<T>(brandId: string, fn: (list: ReplyDraft[]) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const list = await (async () => {
      try {
        return clean(JSON.parse(await fs.readFile(file(brandId), 'utf8')))
      } catch {
        return []
      }
    })()
    const out = fn(list)
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(`${file(brandId)}.tmp`, JSON.stringify(list.slice(0, MAX)), 'utf8')
    await fs.rename(`${file(brandId)}.tmp`, file(brandId))
    dataChanged(brandId, 'inbox')
    return out
  }
  const next = (queues.get(brandId) ?? Promise.resolve()).then(run, run)
  queues.set(brandId, next.catch(() => {}))
  return next
}

export function addReplyDraft(brandId: string, commentId: string, text: string): Promise<ReplyDraft> {
  return change(brandId, (list) => {
    const d: ReplyDraft = { id: randomUUID(), commentId, text, at: Date.now(), sentAt: 0 }
    const i = list.findIndex((x) => x.commentId === commentId && !x.sentAt)
    if (i >= 0) list.splice(i, 1)
    list.unshift(d)
    return d
  })
}

export async function findReplyDraft(brandId: string, commentId: string): Promise<ReplyDraft | null> {
  return (await listReplyDrafts(brandId)).find((d) => d.commentId === commentId && !d.sentAt) ?? null
}

export function markReplySent(brandId: string, commentId: string): Promise<void> {
  return change(brandId, (list) => {
    for (const d of list) if (d.commentId === commentId && !d.sentAt) d.sentAt = Date.now()
  })
}

export function removeReplyDraft(brandId: string, id: string): Promise<void> {
  return change(brandId, (list) => {
    const i = list.findIndex((d) => d.id === id)
    if (i >= 0) list.splice(i, 1)
  })
}

export async function dropReplies(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await queues.get(brandId)
  await fs.rm(file(brandId), { force: true })
}
