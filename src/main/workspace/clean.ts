import { isAbsolute } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import {
  GENERAL_PROJECT_ID,
  generalProject,
  PROJECT_STATUSES,
  type ChatProjects,
  type PipelineStage,
  type Project,
  type ProjectStatus
} from '@shared/workspace'
import { cleanStages, defaultStages, migrateStages } from '../pipeline/model'

const MAX_PROJECTS = 2000
const MAX_THREADS_PER_PROJECT = 1000
const MAX_LINKED_CHATS = 5000
const MAX_LINKS_PER_CHAT = 50

// a brand with no pipeline, or an empty or broken one, gets the default.
// the stage rules live with the pipeline engine so the agent and the ui agree on them
export function cleanPipeline(raw: unknown): PipelineStage[] {
  const stages = migrateStages(cleanStages(raw))
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
    threadIds: threadIds.slice(0, MAX_THREADS_PER_PROJECT),
    ...(typeof p.folder === 'string' && isAbsolute(p.folder) && p.folder.length <= 1000 ? { folder: p.folder } : {})
  }
}

// General always exists and comes first, ids are unique. threadIds are left as they were read,
// cleanChatProjects turns them into links or rebuilds them from the links
export function cleanProjects(raw: unknown, pipeline: PipelineStage[], now: number): Project[] {
  const stageIds = new Set(pipeline.map((s) => s.id))
  const first = pipeline[0].id
  const list = Array.isArray(raw)
    ? raw.map((p) => cleanProject(p, stageIds, first)).filter((p): p is Project => p !== null)
    : []
  const seen = new Set<string>()
  const out: Project[] = []
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  const gi = out.findIndex((p) => p.id === GENERAL_PROJECT_ID)
  const general = gi >= 0 ? out.splice(gi, 1)[0] : generalProject(first, now)
  return [general, ...out].slice(0, MAX_PROJECTS)
}

// the chat side of the links. a file from before chatProjects existed has none: each chat a
// project listed in threadIds gets linked to it, chats in General stay unlinked. after that the
// links are the truth and every project's threadIds is rebuilt from them
export function cleanChatProjects(raw: unknown, projects: Project[]): { projects: Project[]; chatProjects: ChatProjects } {
  const known = new Set(projects.filter((p) => p.id !== GENERAL_PROJECT_ID).map((p) => p.id))
  const links: ChatProjects = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [threadId, ids] of Object.entries(raw).slice(0, MAX_LINKED_CHATS)) {
      if (!ID_PATTERN.test(threadId) || !Array.isArray(ids)) continue
      const clean = [...new Set(ids.filter((id): id is string => typeof id === 'string' && known.has(id)))].slice(0, MAX_LINKS_PER_CHAT)
      if (clean.length) links[threadId] = clean
    }
  } else {
    for (const p of projects) {
      if (!known.has(p.id)) continue
      for (const t of p.threadIds) links[t] = [...new Set([...(links[t] ?? []), p.id])]
    }
  }
  const linked = (id: string): string[] =>
    Object.keys(links).filter((t) => links[t].includes(id)).slice(0, MAX_THREADS_PER_PROJECT)
  return {
    chatProjects: links,
    projects: projects.map((p) => ({ ...p, threadIds: known.has(p.id) ? linked(p.id) : [] }))
  }
}
