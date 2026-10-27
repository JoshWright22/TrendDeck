import { ID_PATTERN } from '@shared/types'
import {
  GENERAL_PROJECT_ID,
  generalProject,
  PROJECT_STATUSES,
  type PipelineStage,
  type Project,
  type ProjectStatus
} from '@shared/workspace'
import { cleanStages, defaultStages } from '../pipeline/model'

const MAX_PROJECTS = 2000
const MAX_THREADS_PER_PROJECT = 1000

// a brand with no pipeline, or an empty or broken one, gets the default.
// the stage rules live with the pipeline engine so the agent and the ui agree on them
export function cleanPipeline(raw: unknown): PipelineStage[] {
  const stages = cleanStages(raw)
  return stages.length ? stages : defaultStages()
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
