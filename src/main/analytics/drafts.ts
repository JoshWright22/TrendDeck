import {
  ID_PATTERN,
  WRITER_PLATFORMS,
  type Draft,
  type DraftVersion,
  type PlatformDraft,
  type WriterDoc,
  type WriterPlatform
} from '@shared/types'

// writer drafts live here too so all the new main process code sits in one folder

const MAX_DRAFTS = 500
const MAX_VERSIONS = 30
const MAX_FIELD = 40000
const MAX_POSTS = 25

function fields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[a-z]{1,20}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, MAX_FIELD)
  }
  return out
}

function thread(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .filter((p): p is string => typeof p === 'string')
        .slice(0, MAX_POSTS)
        .map((p) => p.slice(0, 4000))
    : []
}

function cleanVersion(raw: unknown): DraftVersion | null {
  const v = raw as Partial<DraftVersion> | null
  if (!v || typeof v.id !== 'string' || !ID_PATTERN.test(v.id)) return null
  return {
    id: v.id,
    at: Number(v.at) || 0,
    kind: v.kind === 'generated' ? 'generated' : 'manual',
    fields: fields(v.fields),
    thread: thread(v.thread)
  }
}

function cleanPlatform(raw: unknown): PlatformDraft {
  const p = raw as Partial<PlatformDraft> | null
  const versions = Array.isArray(p?.versions)
    ? p.versions.map(cleanVersion).filter((v): v is DraftVersion => v !== null)
    : []
  return { fields: fields(p?.fields), thread: thread(p?.thread), versions: versions.slice(0, MAX_VERSIONS) }
}

function cleanDraft(raw: unknown): Draft | null {
  const d = raw as Partial<Draft> | null
  if (!d || typeof d.id !== 'string' || !ID_PATTERN.test(d.id)) return null
  const ideaId = typeof d.ideaId === 'string' && ID_PATTERN.test(d.ideaId) ? d.ideaId : null
  const platforms = {} as Record<WriterPlatform, PlatformDraft>
  for (const p of WRITER_PLATFORMS) {
    platforms[p] = cleanPlatform((d.platforms as Record<string, unknown> | undefined)?.[p])
  }
  return {
    id: d.id,
    ideaId,
    title: typeof d.title === 'string' ? d.title.slice(0, 300) : 'Untitled',
    createdAt: Number(d.createdAt) || 0,
    updatedAt: Number(d.updatedAt) || 0,
    platforms
  }
}

export function cleanWriterDoc(raw: unknown): WriterDoc {
  const d = raw as Partial<WriterDoc> | null
  const drafts = Array.isArray(d?.drafts)
    ? d.drafts.map(cleanDraft).filter((x): x is Draft => x !== null)
    : []
  return { drafts: drafts.slice(0, MAX_DRAFTS) }
}
