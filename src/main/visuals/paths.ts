import { app } from 'electron'
import { join } from 'node:path'
import { servedVisual } from './store'

// kept apart from index.ts so the td-media protocol can use it without pulling in the rest

export const visualsRoot = (): string => join(app.getPath('userData'), 'visuals')

// for td-media://visual/<brand>/<name>
export function servedVisualPath(brandId: string, name: string): { path: string; ext: string } | null {
  return servedVisual(visualsRoot(), brandId, name)
}
