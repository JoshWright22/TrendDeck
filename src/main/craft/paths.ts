import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { Project } from '@shared/workspace'
import { getData } from '../store'
import { listProjects, saveProject } from '../workspace'
import { spec } from './catalog'
import { brandRoot } from './root'
import { isInside, safeName, uniqueName } from './rules'

// every TrendDeck project (one video) has a folder for its files: footage, the craft apps'
// project files and exports. Documents\TrendDeck\<brand>\<project>\, made the first time
// something needs it, and remembered on the project so renaming it later doesn't move anything

export { brandRoot, projectsRoot } from './root'

export function findProject(brandId: string, projectId: string): { brandName: string; brandDir: string; project: Project } {
  const brand = ID_PATTERN.test(brandId) ? getData()?.brands.find((b) => b.id === brandId) : undefined
  if (!brand) throw new Error('no brand with that id')
  const project = brand.projects.find((p) => p.id === projectId)
  if (!project) throw new Error('no project with that id in this brand')
  return { brandName: brand.name, brandDir: brandRoot(brand), project }
}

// one at a time, two calls for a new project must not make two folders
let queue: Promise<unknown> = Promise.resolve()

// the project's folder, made if it isn't there
export function projectFolder(brandId: string, projectId: string): Promise<string> {
  const run = async (): Promise<string> => {
    const { brandDir, project } = findProject(brandId, projectId)
    if (project.folder) {
      await fs.mkdir(project.folder, { recursive: true })
      return project.folder
    }
    await fs.mkdir(brandDir, { recursive: true })
    // a folder that's on disk or that another project already claimed is taken
    const taken = new Set<string>(await fs.readdir(brandDir).catch(() => []))
    for (const p of listProjects(brandId)) {
      if (p.folder && isInside(brandDir, p.folder)) taken.add(p.folder.slice(brandDir.length + 1))
    }
    const dir = join(brandDir, uniqueName(safeName(project.name), taken))
    await fs.mkdir(dir, { recursive: true })
    // the latest copy of the project, saveProject replaces it whole
    const fresh = findProject(brandId, projectId).project
    await saveProject(brandId, { ...fresh, folder: dir })
    return dir
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

// the folder if it was made already, without making it
export function knownFolder(brandId: string, projectId: string): string | null {
  try {
    return findProject(brandId, projectId).project.folder ?? null
  } catch {
    return null
  }
}

// files of this app's types in the folder, newest first
export async function appFiles(dir: string, appId: string): Promise<{ name: string; modified: number }[]> {
  const exts = spec(appId).exts.map((e) => e.toLowerCase())
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: { name: string; modified: number }[] = []
  for (const name of names) {
    if (!exts.includes(extname(name).toLowerCase())) continue
    try {
      const st = await fs.stat(join(dir, name))
      if (st.isFile()) out.push({ name, modified: st.mtimeMs })
    } catch {
      // gone since readdir
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}
