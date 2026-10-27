import { ID_PATTERN } from '@shared/types'
import {
  DEFAULT_PIPELINE,
  GENERAL_PROJECT_ID,
  generalProject,
  MAX_STAGES,
  PROJECT_STATUSES,
  STAGE_KINDS,
  type PipelineStage,
  type Project,
  type ProjectStatus,
  type StageKind
} from '@shared/workspace'

const MAX_PROJECTS = 2000
const MAX_THREADS_PER_PROJECT = 1000
// workspace keys pick a view in the renderer, so only plain names
const WORKSPACE_KEY = /^[a-z0-9-]{1,40}$/

function cleanStage(raw: unknown): PipelineStage | null {
  const s = raw as Partial<PipelineStage> | null
  if (!s || typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return null
  const label = typeof s.label === 'string' ? s.label.trim().slice(0, 40) : ''
  if (!label) return null
  const kind: StageKind = (STAGE_KINDS as readonly string[]).includes(s.kind as string) ? (s.kind as StageKind) : 'custom'
  const workspace = typeof s.workspace === 'string' && WORKSPACE_KEY.test(s.workspace) ? s.workspace : 'none'
  return { id: s.id, label, kind, workspace }
}

// a brand with no pipeline, or an empty or broken one, gets the default
export function cleanPipeline(raw: unknown): PipelineStage[] {
  const stages = Array.isArray(raw) ? raw.map(cleanStage).filter((s): s is PipelineStage => s !== null) : []
  const seen = new Set<string>()
  const unique = stages.filter((s) => !seen.has(s.id) && seen.add(s.id)).slice(0, MAX_STAGES)
  return unique.length ? unique : DEFAULT_PIPELINE.map((s) => ({ ...s }))
}

function cleanProject(raw: unknown, stageIds: Set<string>, firstStage: string): Project | null {
  const p = raw as Partial<Project> | null
  if (!p || typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) return null
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : ''
  if (!name) return null
  const status: ProjectStatus = (PROJECT_STATUSES as readonly string[]).includes(p.status as string)
    ? (p.status as ProjectStatus)
    : 'idle'
  const threadIds = Array.isArray(p.threadIds)
    ? [...new Set(p.threadIds.filter((t): t is string => typeof t === 'string' && ID_PATTERN.test(t)))]
    : []
  return {
    id: p.id,
    name,
    createdAt: Number(p.createdAt) || 0,
    // a stage that was taken out of the pipeline puts the project back on the first one
    stageId: typeof p.stageId === 'string' && stageIds.has(p.stageId) ? p.stageId : firstStage,
    status,
    threadIds: threadIds.slice(0, MAX_THREADS_PER_PROJECT)
  }
}

// General always exists and comes first, ids are unique and a thread is only in one project
export function cleanProjects(raw: unknown, pipeline: PipelineStage[], now: number): Project[] {
  const stageIds = new Set(pipeline.map((s) => s.id))
  const first = pipeline[0].id
  const list = Array.isArray(raw)
    ? raw.map((p) => cleanProject(p, stageIds, first)).filter((p): p is Project => p !== null)
    : []
  const seen = new Set<string>()
  const taken = new Set<string>()
  const out: Project[] = []
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const threadIds = p.threadIds.filter((t) => !taken.has(t))
    threadIds.forEach((t) => taken.add(t))
    out.push({ ...p, threadIds })
  }
  const gi = out.findIndex((p) => p.id === GENERAL_PROJECT_ID)
  const general = gi >= 0 ? out.splice(gi, 1)[0] : generalProject(first, now)
  return [general, ...out].slice(0, MAX_PROJECTS)
}
