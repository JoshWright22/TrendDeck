import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { QC_TARGETS, type QcOptions, type QcProgress, type QcReport, type QcTarget } from '@shared/qc'
import { ID_PATTERN } from '@shared/types'
import { getData } from '../store'
import { broadcast } from '../gateway/wait'
import { analyze } from './analyze'

// pre-publish checks on a file in a project's folder, for the window (qc:run) and the agent
// (qc_run). the folder is the one main/craft made for the project, Documents\TrendDeck\<brand>\<project>\

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv']

export class QcError extends Error {}

type FolderOf = (brandId: string, projectId: string) => Promise<string | null> | string | null

// the project's folder as saved on it. main/craft can swap in its own lookup with setQcFolder
let folderOf: FolderOf = (brandId, projectId) => {
  const brand = ID_PATTERN.test(brandId) ? getData()?.brands.find((b) => b.id === brandId) : undefined
  if (!brand) throw new QcError('no brand with that id')
  const project = brand.projects.find((p) => p.id === projectId)
  if (!project) throw new QcError('no project with that id in this brand')
  const folder = (project as { folder?: unknown }).folder
  return typeof folder === 'string' && folder ? folder : null
}

export function setQcFolder(fn: FolderOf): void {
  folderOf = fn
}

function inside(dir: string, p: string): boolean {
  const r = relative(dir, p)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

// a name in the folder, never a path out of it
function fileIn(dir: string, name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 260 || name.includes('\0')) throw new QcError('bad file name')
  const p = resolve(dir, name)
  if (!inside(resolve(dir), p)) throw new QcError(`${name} isn't in the project folder`)
  return p
}

export async function projectDir(brandId: string, projectId: string): Promise<string> {
  const dir = await folderOf(brandId, projectId)
  if (!dir) throw new QcError("this project has no folder yet, export the video into it first")
  return dir
}

// the project's videos, newest first, for the agent to pick from
export async function projectVideos(brandId: string, projectId: string): Promise<{ name: string; modified: number }[]> {
  const dir = await folderOf(brandId, projectId)
  if (!dir) return []
  const out: { name: string; modified: number }[] = []
  const walk = async (sub: string, depth: number): Promise<void> => {
    let names: string[]
    try {
      names = await fs.readdir(join(dir, sub))
    } catch {
      return
    }
    for (const n of names) {
      const rel = sub ? `${sub}/${n}` : n
      try {
        const st = await fs.stat(join(dir, rel))
        if (st.isDirectory() && depth < 1) await walk(rel, depth + 1)
        else if (st.isFile() && VIDEO_EXTS.some((e) => n.toLowerCase().endsWith(e))) out.push({ name: rel, modified: st.mtimeMs })
      } catch {
        // gone since readdir
      }
    }
  }
  await walk('', 0)
  return out.sort((a, b) => b.modified - a.modified)
}

function cleanOpts(raw: unknown): QcOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const out: QcOptions = {}
  if (typeof o.target === 'string' && (QC_TARGETS as readonly string[]).includes(o.target)) out.target = o.target as QcTarget
  if (typeof o.captions === 'string' && o.captions) out.captions = o.captions
  if (typeof o.transcript === 'string' && o.transcript) out.transcript = o.transcript
  return out
}

// the same file checked twice at once shares one run
const running = new Map<string, Promise<QcReport>>()

export async function runQc(brandId: string, projectId: string, file: string, rawOpts?: unknown): Promise<QcReport> {
  const dir = await projectDir(brandId, projectId)
  const path = fileIn(dir, file)
  const opts = cleanOpts(rawOpts)
  // sidecar names are checked the same way, then handed on relative to the video
  if (opts.captions) opts.captions = relative(resolve(path, '..'), fileIn(dir, opts.captions))
  if (opts.transcript) opts.transcript = relative(resolve(path, '..'), fileIn(dir, opts.transcript))
  try {
    if (!(await fs.stat(path)).isFile()) throw new QcError(`${file} isn't a file`)
  } catch (err) {
    if (err instanceof QcError) throw err
    throw new QcError(`no file called ${file} in the project folder`)
  }
  const key = JSON.stringify([path, opts])
  const had = running.get(key)
  if (had) return had
  let last = 0
  const p = analyze(path, {
    ...opts,
    onProgress: (progress) => {
      // a few updates a second at most
      const now = Date.now()
      if (progress < 1 && now - last < 200) return
      last = now
      broadcast('qc:progress', { brandId, projectId, file, progress } satisfies QcProgress)
    }
  }).finally(() => running.delete(key))
  running.set(key, p)
  const report = await p
  return { ...report, file }
}
