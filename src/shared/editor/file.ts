import { SCHEMA_VERSION, type Project } from './model'
import { checkProject } from './timeline'

// the .tdproj format: a small envelope around the project JSON. every change to the shape of
// Project bumps SCHEMA_VERSION and adds a migration from the version before, so old files open

export const FILE_FORMAT = 'tdproj'

export interface ProjectFile {
  format: typeof FILE_FORMAT
  schemaVersion: number
  savedAt: number
  project: Project
}

export interface Migration {
  // upgrades a project of schemaVersion `from` to `from + 1`, given raw JSON
  from: number
  up(raw: Record<string, unknown>): Record<string, unknown>
}

// version 1 is the first shipped shape, so nothing to upgrade yet. add new steps at the end:
//   { from: 1, up: (p) => ({ ...p, newField: defaultValue }) }
export const MIGRATIONS: Migration[] = []

export class ProjectFileError extends Error {}

export function migrateProject(raw: unknown, migrations: Migration[] = MIGRATIONS, target = SCHEMA_VERSION): Project {
  if (!raw || typeof raw !== 'object') throw new ProjectFileError('project file is empty or not JSON')
  let p = raw as Record<string, unknown>
  let v = typeof p.schemaVersion === 'number' ? p.schemaVersion : 0
  if (v > target) throw new ProjectFileError(`project was saved by a newer TrendDeck (format ${v}), update the app to open it`)
  while (v < target) {
    const m = migrations.find((x) => x.from === v)
    if (!m) throw new ProjectFileError(`no upgrade path from project format ${v}`)
    p = { ...m.up(p), schemaVersion: v + 1 }
    v++
  }
  return normalize(p as unknown as Project)
}

// fills fields a hand-edited or partly written file may lack, so the rest of the editor can
// trust the shape
function normalize(p: Project): Project {
  if (!p.id || !p.items || !p.bins || !p.rootBinId) throw new ProjectFileError('project file is missing required fields')
  const items = { ...p.items }
  for (const [id, it] of Object.entries(items)) {
    if (it.kind === 'sequence') {
      items[id] = {
        ...it,
        videoTracks: it.videoTracks ?? [],
        audioTracks: it.audioTracks ?? [],
        captionTracks: it.captionTracks ?? [],
        markers: it.markers ?? []
      }
    } else if (it.kind === 'media') {
      items[id] = { ...it, proxyPath: it.proxyPath ?? null, transcript: it.transcript ?? null, libraryId: it.libraryId ?? null }
    }
  }
  const out = { ...p, items }
  checkProject(out)
  return out
}

export function serializeProject(project: Project, savedAt = Date.now()): string {
  const file: ProjectFile = { format: FILE_FORMAT, schemaVersion: project.schemaVersion, savedAt, project }
  return JSON.stringify(file)
}

export function parseProjectFile(text: string, migrations?: Migration[]): { project: Project; savedAt: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProjectFileError('project file is not valid JSON')
  }
  const env = raw as Partial<ProjectFile>
  if (env?.format !== FILE_FORMAT || !env.project) throw new ProjectFileError('not a TrendDeck project file')
  const project = migrateProject({ ...env.project, schemaVersion: env.schemaVersion ?? env.project.schemaVersion }, migrations)
  return { project, savedAt: env.savedAt ?? 0 }
}
