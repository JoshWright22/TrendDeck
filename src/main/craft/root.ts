import { app } from 'electron'
import { join } from 'node:path'
import type { Brand } from '@shared/types'
import { safeName } from './rules'

// Documents\TrendDeck, where every brand has its folder. on its own so the store can use it
export function projectsRoot(): string {
  return process.env.TRENDDECK_PROJECTS_DIR || join(app.getPath('documents'), 'TrendDeck')
}

// the brand's folder name: the one it kept through a rename, else named after the brand
export function brandFolderName(brand: Pick<Brand, 'name' | 'folderName'>): string {
  return brand.folderName || safeName(brand.name, 'Brand')
}

// Documents\TrendDeck\<brand>
export function brandRoot(brand: Pick<Brand, 'name' | 'folderName'>): string {
  return join(projectsRoot(), brandFolderName(brand))
}
