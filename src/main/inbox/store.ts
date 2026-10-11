import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { INBOX_SITES, type BrandInbox, type InboxComment } from '@shared/inbox'

// one inbox/<brand>.json, kept apart from the main store
const MAX_COMMENTS = 2000

function file(brandId: string): string {
  return join(app.getPath('userData'), 'inbox', `${brandId}.json`)
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')

function cleanComment(raw: unknown): InboxComment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const site = INBOX_SITES.find((s) => s === r.site)
  const id = str(r.id, 300)
  if (!site || !id) return null
  return {
    id,
    site,
    account: str(r.account, 200),
    author: str(r.author, 200),
    authorUrl: str(r.authorUrl, 1000),
    text: str(r.text),
    url: str(r.url, 2000),
    postTitle: str(r.postTitle, 500),
    at: typeof r.at === 'number' ? r.at : 0,
    read: r.read === true
  }
}

export function emptyInbox(): BrandInbox {
  return { health: {}, comments: [], blocked: [], keywords: [], refreshedAt: 0 }
}

function clean(raw: unknown): BrandInbox {
  const out = emptyInbox()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (r.health && typeof r.health === 'object') {
    for (const [k, v] of Object.entries(r.health as Record<string, unknown>)) {
      const h = v as Record<string, unknown>
      if (h && (h.state === 'in' || h.state === 'out' || h.state === 'unknown')) {
        out.health[k] = { siteId: k, host: str(h.host, 200), state: h.state, checkedAt: Number(h.checkedAt) || 0 }
      }
    }
  }
  if (Array.isArray(r.comments)) {
    out.comments = r.comments.map(cleanComment).filter((c): c is InboxComment => !!c).slice(0, MAX_COMMENTS)
  }
  if (Array.isArray(r.blocked)) out.blocked = r.blocked.map((b) => str(b, 300)).filter(Boolean)
  if (Array.isArray(r.keywords)) out.keywords = r.keywords.map((b) => str(b, 100)).filter(Boolean)
  out.refreshedAt = Number(r.refreshedAt) || 0
  return out
}

const cache = new Map<string, BrandInbox>()

export async function loadInbox(brandId: string): Promise<BrandInbox> {
  const hit = cache.get(brandId)
  if (hit) return hit
  let raw: unknown = null
  try {
    raw = JSON.parse(await fs.readFile(file(brandId), 'utf8'))
  } catch {
    raw = null
  }
  const inbox = clean(raw)
  cache.set(brandId, inbox)
  return inbox
}

const queues = new Map<string, Promise<void>>()

export function saveInbox(brandId: string, inbox: BrandInbox): Promise<void> {
  inbox.comments = inbox.comments.slice(0, MAX_COMMENTS)
  cache.set(brandId, inbox)
  const path = file(brandId)
  const run = async (): Promise<void> => {
    await fs.mkdir(join(app.getPath('userData'), 'inbox'), { recursive: true })
    await fs.writeFile(`${path}.tmp`, JSON.stringify(inbox), 'utf8')
    await fs.rename(`${path}.tmp`, path)
  }
  const next = (queues.get(path) ?? Promise.resolve()).then(run, run)
  queues.set(path, next)
  return next
}

export async function dropInbox(brandId: string): Promise<void> {
  cache.delete(brandId)
  await fs.rm(file(brandId), { force: true })
}
