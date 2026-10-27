import type { Bin, Id, Project, ProjectItem } from './model'

// keeps a copy of a project in step with the authoritative one across IPC. the main process
// owns the session; after each change it sends only the items whose object changed, which
// structural sharing makes a cheap reference check

export interface ProjectPatch {
  // version this patch applies on top of, and the version it produces
  base: number
  version: number
  // top level fields other than items and bins, when any changed
  meta?: Omit<Project, 'items' | 'bins'>
  // the whole bin map, when any bin changed (bins are tiny)
  bins?: Record<Id, Bin>
  // changed items, null for deleted ones
  items: Record<Id, ProjectItem | null>
}

export function diffProject(prev: Project, next: Project, base: number, version: number): ProjectPatch {
  const patch: ProjectPatch = { base, version, items: {} }
  const { items: _pi, bins: pb, ...pm } = prev
  const { items: _ni, bins: nb, ...nm } = next
  void _pi
  void _ni
  if ((Object.keys(nm) as (keyof typeof nm)[]).some((k) => nm[k] !== pm[k])) patch.meta = nm
  if (pb !== nb) patch.bins = nb
  if (prev.items !== next.items) {
    for (const [id, it] of Object.entries(next.items)) if (prev.items[id] !== it) patch.items[id] = it
    for (const id of Object.keys(prev.items)) if (!(id in next.items)) patch.items[id] = null
  }
  return patch
}

// null when the patch doesn't follow on from `version`; ask for a full snapshot then
export function applyPatch(project: Project, version: number, patch: ProjectPatch): Project | null {
  if (patch.base !== version) return null
  let items = project.items
  const ids = Object.keys(patch.items)
  if (ids.length) {
    items = { ...items }
    for (const id of ids) {
      const it = patch.items[id]
      if (it === null) delete items[id]
      else items[id] = it
    }
  }
  return { ...project, ...(patch.meta ?? {}), bins: patch.bins ?? project.bins, items }
}
