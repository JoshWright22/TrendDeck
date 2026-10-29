import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Brand } from '@shared/types'
import { defaultRoot } from './root-paths'
import { safeName } from './rules'

// where every brand has its folder: Documents\TrendDeck, or Videos\TrendDeck when OneDrive has
// Documents (root-paths.ts). on its own so the store can use it
let resolved: string | null = null

export const oldRoot = (): string => join(app.getPath('documents'), 'TrendDeck')
export const newRoot = (): string => defaultRoot({ documents: app.getPath('documents'), videos: app.getPath('videos'), home: homedir() })

export function setProjectsRoot(dir: string): void {
  resolved = dir
}

export function projectsRoot(): string {
  if (process.env.TRENDDECK_PROJECTS_DIR) return process.env.TRENDDECK_PROJECTS_DIR
  if (resolved) return resolved
  // projects still in OneDrive (the move below couldn't happen) stay where they are
  const next = newRoot()
  const old = oldRoot()
  resolved = next !== old && !existsSync(next) && existsSync(old) ? old : next
  return resolved
}

// the brand's folder name: the one it kept through a rename, else named after the brand
export function brandFolderName(brand: Pick<Brand, 'name' | 'folderName'>): string {
  return brand.folderName || safeName(brand.name, 'Brand')
}

// <projects folder><brand>
export function brandRoot(brand: Pick<Brand, 'name' | 'folderName'>): string {
  return join(projectsRoot(), brandFolderName(brand))
}
