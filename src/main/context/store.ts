import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { ContextState, StyleRule } from '@shared/context'
import { projectsRoot } from '../craft/paths'
import { safeName } from '../craft/rules'
import { broadcast } from '../gateway/wait'
import { getData } from '../store'
import { cleanDocsIndex, scanDocs, type DocsIndex } from './docs'
import { cleanRules } from './rules'
import { scanTranscripts, type ProjectDir, type TranscriptEntry } from './transcripts'

// userData/context/<brand>.json has the docs folder and the style rules,
// <brand>-docs.json the docs index with each file's text and mtime

export interface ContextFile {
  docsFolder: string | null
  rules: StyleRule[]
}

const dir = (): string => join(app.getPath('userData'), 'context')

function checkId(brandId: string): string {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
  return brandId
}

const settingsPath = (brandId: string): string => join(dir(), `${checkId(brandId)}.json`)
const docsPath = (brandId: string): string => join(dir(), `${checkId(brandId)}-docs.json`)

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(`${path}.tmp`, JSON.stringify(value), 'utf8')
  await fs.rename(`${path}.tmp`, path)
}

// one change at a time per brand, so two quick edits can't lose one
const queues = new Map<string, Promise<unknown>>()

function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
  queues.set(key, next.catch(() => {}))
  return next
}

function cleanFile(raw: unknown): ContextFile {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Partial<ContextFile>
  const folder = typeof x.docsFolder === 'string' && isAbsolute(x.docsFolder) ? x.docsFolder : null
  return { docsFolder: folder, rules: cleanRules(x.rules) }
}

export async function loadContext(brandId: string): Promise<ContextFile> {
  return cleanFile(await readJson(settingsPath(brandId)))
}

// read, change and write back in one go. fn returns what the caller gets
export function changeContext<T>(brandId: string, fn: (f: ContextFile) => { file: ContextFile; out: T }): Promise<T> {
  const path = settingsPath(brandId)
  return serial(path, async () => {
    const { file, out } = fn(cleanFile(await readJson(path)))
    await writeAtomic(path, file)
    return out
  })
}

export function changed(brandId: string): void {
  broadcast('context:changed', brandId)
}

// ---------- docs index ----------

const indexes = new Map<string, DocsIndex | null>()
const running = new Map<string, Promise<DocsIndex | null>>()
const again = new Set<string>()
const errors = new Map<string, string>()
// a search kicks off a fresh scan in the background when the index is older than this
const STALE_MS = 10 * 60_000

async function loadIndex(brandId: string): Promise<DocsIndex | null> {
  if (!indexes.has(brandId)) indexes.set(brandId, cleanDocsIndex(await readJson(docsPath(brandId))))
  return indexes.get(brandId) ?? null
}

export const isIndexing = (brandId: string): boolean => running.has(brandId)

// scans the docs folder again, incremental. a call while one runs makes it run once more after
export function reindexDocs(brandId: string): Promise<DocsIndex | null> {
  const busy = running.get(brandId)
  if (busy) {
    again.add(brandId)
    return busy
  }
  const run = async (): Promise<DocsIndex | null> => {
    let result: DocsIndex | null = null
    do {
      again.delete(brandId)
      const { docsFolder } = await loadContext(brandId)
      if (!docsFolder) {
        result = null
        indexes.set(brandId, null)
        await serial(docsPath(brandId), () => fs.rm(docsPath(brandId), { force: true }))
        break
      }
      try {
        const st = await fs.stat(docsFolder)
        if (!st.isDirectory()) throw new Error('not a folder')
      } catch {
        errors.set(brandId, "TrendDeck can't open that folder anymore. Pick it again or choose another one.")
        result = await loadIndex(brandId)
        break
      }
      const index = await scanDocs(docsFolder, await loadIndex(brandId))
      // the folder could have changed while it scanned
      if ((await loadContext(brandId)).docsFolder !== docsFolder) {
        again.add(brandId)
        continue
      }
      await serial(docsPath(brandId), () => writeAtomic(docsPath(brandId), index))
      indexes.set(brandId, index)
      errors.delete(brandId)
      result = index
    } while (again.has(brandId))
    return result
  }
  const p = run()
    .catch(() => {
      errors.set(brandId, 'Indexing stopped partway. Try Re-index.')
      return indexes.get(brandId) ?? null
    })
    .finally(() => {
      running.delete(brandId)
      changed(brandId)
    })
  running.set(brandId, p)
  changed(brandId)
  return p
}

// the index for the current folder, made first if there is none yet
export async function docsIndex(brandId: string): Promise<{ folder: string | null; index: DocsIndex | null }> {
  const { docsFolder } = await loadContext(brandId)
  if (!docsFolder) return { folder: null, index: null }
  const have = await loadIndex(brandId)
  if (!have || have.folder !== docsFolder) return { folder: docsFolder, index: await reindexDocs(brandId) }
  if (Date.now() - have.indexedAt > STALE_MS && !isIndexing(brandId)) void reindexDocs(brandId)
  return { folder: docsFolder, index: have }
}

// ---------- transcripts ----------

const transcriptCache = new Map<string, { at: number; list: TranscriptEntry[] }>()
const TRANSCRIPT_FRESH_MS = 30_000

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// each project's own folder, then any other folders in the brand's folder under Documents\TrendDeck
async function projectDirs(brandId: string): Promise<ProjectDir[]> {
  const brand = getData()?.brands.find((b) => b.id === brandId)
  if (!brand) return []
  const out: ProjectDir[] = []
  for (const p of brand.projects) {
    if (p.folder && isAbsolute(p.folder) && (await isDir(p.folder))) out.push({ name: p.name, dir: p.folder })
  }
  const brandDir = join(projectsRoot(), safeName(brand.name, 'Brand'))
  try {
    for (const e of await fs.readdir(brandDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(brandDir, e.name)
      if (!out.some((o) => o.dir.toLowerCase() === full.toLowerCase())) out.push({ name: e.name, dir: full })
    }
  } catch {
    // no brand folder yet
  }
  return out
}

export async function transcripts(brandId: string, fresh = false): Promise<TranscriptEntry[]> {
  const hit = transcriptCache.get(brandId)
  if (!fresh && hit && Date.now() - hit.at < TRANSCRIPT_FRESH_MS) return hit.list
  const list = await scanTranscripts(await projectDirs(brandId))
  transcriptCache.set(brandId, { at: Date.now(), list })
  return list
}

// ---------- state for the settings screen ----------

export async function contextState(brandId: string): Promise<ContextState> {
  const file = await loadContext(brandId)
  const index = await loadIndex(brandId)
  const current = index && index.folder === file.docsFolder ? index : null
  const list = await transcripts(brandId)
  return {
    docsFolder: file.docsFolder,
    docs: (current?.files ?? []).map((f) => ({ file: f.file, chars: f.text.length, modified: f.mtimeMs })),
    transcripts: list.map((t) => ({ project: t.project, file: t.file, chars: t.text.length })),
    rules: file.rules,
    indexing: isIndexing(brandId),
    lastIndexedAt: current?.indexedAt || null,
    error: errors.get(brandId) ?? null
  }
}

export async function dropBrandFiles(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await (running.get(brandId) ?? Promise.resolve()).catch(() => {})
  await serial(settingsPath(brandId), () => fs.rm(settingsPath(brandId), { force: true }))
  await serial(docsPath(brandId), () => fs.rm(docsPath(brandId), { force: true }))
  indexes.delete(brandId)
  errors.delete(brandId)
  transcriptCache.delete(brandId)
}
