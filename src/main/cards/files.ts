import { promises as fs } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { kindOf } from '@shared/media'
import type { ProjectFileRef } from '@shared/cards'
import { ID_PATTERN } from '@shared/types'
import { findProject, knownFolder, projectFolder } from '../craft/paths'
import { isInside, PathError, resolveInProject } from '../craft/rules'

// files in a project folder the chat may show: video, images and audio only, never anything
// outside the folder. the window gets them as td-media://project/<brand>/<project>/<file>

export class FileRefError extends Error {}

// a project relative path with forward slashes, as cards keep it
export function relativeIn(root: string, full: string): string {
  return relative(root, full).split(sep).join('/')
}

export function refKind(file: string): ProjectFileRef['kind'] | null {
  const k = kindOf(extname(file).slice(1))
  return k === 'video' || k === 'image' || k === 'audio' ? k : null
}

// checks a file the agent named: in the project folder, there, and something the chat can play
export async function checkProjectFile(brandId: string, projectId: string, file: string): Promise<{ ref: ProjectFileRef; full: string }> {
  findProject(brandId, projectId)
  const root = await projectFolder(brandId, projectId)
  let full: string
  try {
    full = resolveInProject(root, file)
  } catch (err) {
    throw new FileRefError(err instanceof PathError ? err.message : 'that path is not in the project folder')
  }
  const kind = refKind(full)
  if (!kind) throw new FileRefError(`${file} isn't a video, image or audio file`)
  let st
  try {
    st = await fs.lstat(full)
  } catch {
    throw new FileRefError(`${file} isn't in the project folder`)
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new FileRefError(`${file} isn't a plain file`)
  const real = await fs.realpath(full)
  if (!isInside(root, real)) throw new FileRefError(`${file} is outside the project folder`)
  return { ref: { projectId, file: relativeIn(root, full), kind }, full }
}

// the absolute path for td-media://project/..., null when anything is off. never makes a folder
export async function servedPath(brandId: string, projectId: string, file: string): Promise<string | null> {
  if (!ID_PATTERN.test(brandId) || !ID_PATTERN.test(projectId)) return null
  const root = knownFolder(brandId, projectId)
  if (!root || !refKind(file)) return null
  try {
    const full = resolveInProject(root, file)
    const st = await fs.lstat(full)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const real = await fs.realpath(full)
    return isInside(await fs.realpath(root), real) ? real : null
  } catch {
    return null
  }
}

export function projectFileUrl(brandId: string, ref: Pick<ProjectFileRef, 'projectId' | 'file'>): string {
  return `td-media://project/${brandId}/${ref.projectId}/${encodeURIComponent(ref.file)}`
}

// video files a render or export just wrote, newest first. looks two levels down
export async function newVideosSince(root: string, since: number): Promise<string[]> {
  const out: { path: string; at: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory() && depth < 2) await walk(p, depth + 1)
      else if (e.isFile() && refKind(e.name) === 'video') {
        const st = await fs.stat(p).catch(() => null)
        if (st && st.mtimeMs >= since - 2000 && st.size > 0) out.push({ path: p, at: st.mtimeMs })
      }
    }
  }
  await walk(root, 0)
  return out.sort((a, b) => b.at - a.at).map((x) => x.path)
}
