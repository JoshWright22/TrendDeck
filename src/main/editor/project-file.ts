import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseProjectFile, serializeProject, type EditorSession, type Project } from '@shared/editor'

// .tdproj files on disk: atomic saves, rolling autosaves, and a crash journal written about a
// second after each edit so a crash loses at most that second

async function renameRetry(from: string, to: string): Promise<void> {
  // antivirus and indexers briefly lock fresh files on windows
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
}

// write to a temp file in the same folder, flush, then rename over the target
export async function writeAtomic(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(data, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await renameRetry(tmp, path)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export async function saveProjectFile(path: string, project: Project): Promise<void> {
  await writeAtomic(path, serializeProject(project))
}

export interface LoadedProject {
  project: Project
  savedAt: number
  // media whose file isn't where the project says, after trying next to the project file
  missing: string[]
}

// reads, migrates and checks a project. moved media is found again if it sits next to the
// project file or in a media folder beside it
export async function loadProjectFile(path: string): Promise<LoadedProject> {
  const { project, savedAt } = parseProjectFile(await fs.readFile(path, 'utf8'))
  const dir = dirname(path)
  const items = { ...project.items }
  const missing: string[] = []
  for (const it of Object.values(items)) {
    if (it.kind !== 'media' || existsSync(it.path)) continue
    const name = basename(it.path.replace(/\\/g, '/'))
    const found = [join(dir, name), join(dir, 'media', name)].find((p) => existsSync(p))
    if (found) items[it.id] = { ...it, path: found }
    else missing.push(it.id)
  }
  return { project: { ...project, items }, savedAt, missing }
}

export interface JournalEntry {
  projectId: string
  name: string
  filePath: string | null
  at: number
  project: Project
}

export interface AutosaveOptions {
  // folder holding journal/ and autosave/
  dir: string
  filePath: () => string | null
  journalDelayMs?: number
  autosaveEveryMs?: number
  keep?: number
  onError?: (e: unknown) => void
}

export function journalPath(dir: string, projectId: string): string {
  return join(dir, 'journal', `${projectId}.json`)
}

// watches a session: journals ~1 s after edits settle, keeps the last few timed autosaves,
// and drops the journal once the project is saved or closed cleanly
export class ProjectAutosaver {
  private journalTimer: NodeJS.Timeout | null = null
  private autosaveTimer: NodeJS.Timeout | null = null
  private lastAutosaved: Project | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(
    private readonly session: EditorSession,
    private readonly opts: AutosaveOptions
  ) {
    this.lastAutosaved = session.project
    this.unsubscribe = session.subscribe(() => this.scheduleJournal())
    this.autosaveTimer = setInterval(() => void this.autosave(), opts.autosaveEveryMs ?? 120_000)
    this.autosaveTimer.unref?.()
  }

  private scheduleJournal(): void {
    if (this.journalTimer) clearTimeout(this.journalTimer)
    this.journalTimer = setTimeout(() => void this.flushJournal(), this.opts.journalDelayMs ?? 1000)
    this.journalTimer.unref?.()
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    this.writing = this.writing.then(fn).catch((e) => this.opts.onError?.(e))
    return this.writing
  }

  flushJournal(): Promise<void> {
    if (this.journalTimer) clearTimeout(this.journalTimer)
    this.journalTimer = null
    return this.queue(async () => {
      if (!this.session.dirty) {
        await fs.rm(journalPath(this.opts.dir, this.session.project.id), { force: true })
        return
      }
      const p = this.session.project
      const entry: JournalEntry = { projectId: p.id, name: p.name, filePath: this.opts.filePath(), at: Date.now(), project: p }
      await writeAtomic(journalPath(this.opts.dir, p.id), JSON.stringify(entry))
    })
  }

  autosave(): Promise<void> {
    const p = this.session.project
    if (p === this.lastAutosaved) return this.writing
    this.lastAutosaved = p
    return this.queue(async () => {
      const folder = join(this.opts.dir, 'autosave', p.id)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await saveProjectFile(join(folder, `${stamp}.tdproj`), p)
      const files = (await fs.readdir(folder)).filter((f) => f.endsWith('.tdproj')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - (this.opts.keep ?? 10)))) await fs.rm(join(folder, old), { force: true })
    })
  }

  // the project was saved or discarded: the journal has nothing left to recover
  async clearJournal(): Promise<void> {
    if (this.journalTimer) clearTimeout(this.journalTimer)
    this.journalTimer = null
    await this.queue(() => fs.rm(journalPath(this.opts.dir, this.session.project.id), { force: true }))
  }

  async dispose(opts: { keepJournal?: boolean } = {}): Promise<void> {
    this.unsubscribe()
    if (this.autosaveTimer) clearInterval(this.autosaveTimer)
    if (opts.keepJournal) await this.flushJournal()
    else await this.clearJournal()
  }
}

// journals left behind by a crash, newest first
export async function listJournals(dir: string): Promise<JournalEntry[]> {
  const folder = join(dir, 'journal')
  let names: string[]
  try {
    names = await fs.readdir(folder)
  } catch {
    return []
  }
  const out: JournalEntry[] = []
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const entry = JSON.parse(await fs.readFile(join(folder, name), 'utf8')) as JournalEntry
      if (entry?.project?.id) out.push(entry)
    } catch {
      // a torn journal is worthless, skip it
    }
  }
  return out.sort((a, b) => b.at - a.at)
}
