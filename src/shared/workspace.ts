import type { AppData } from './types'

// brand -> chats and video projects, and the pipeline each project runs through.
// a chat is brand-wide and can be linked to any number of the brand's projects.
// shared by the store, the preload, the shell and anything else that reads or edits them

// stages are defined once, in ./pipeline. brand.pipeline in trenddeck.json is the one copy:
// the ui reads it from AppData, main/pipeline reads and writes it through main/workspace
export { STAGE_KINDS, DEFAULT_STAGES as DEFAULT_PIPELINE } from './pipeline'
export type { StageKind, PipelineStage } from './pipeline'
import type { PipelineStage } from './pipeline'

export { MAX_STAGES } from './pipeline'

export const PROJECT_STATUSES = ['idle', 'running', 'waiting', 'done'] as const
// idle: nothing going on. running: the agent is working on it. waiting: needs the user. done: posted and reviewed
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

// one piece of content, one run through the pipeline
export interface Project {
  id: string
  name: string
  createdAt: number
  // the stage it's on, a stage id from the brand's pipeline
  stageId: string
  status: ProjectStatus
  // the chats linked to it. a copy main rebuilds from brand.chatProjects on every save, kept for
  // older code and older app versions that read it. read and write brand.chatProjects instead
  threadIds: string[]
  // its folder for files, Documents\TrendDeck\<brand>\<project>\. set by main the first time
  // something needs it, see main/craft/paths.ts
  folder?: string
}

// every brand has this one, hidden in the ui. it holds files and runs for chats that aren't
// linked to a video, and is never a link target itself
export const GENERAL_PROJECT_ID = 'general'

export function generalProject(stageId: string, createdAt = 0): Project {
  return { id: GENERAL_PROJECT_ID, name: 'General', createdAt, stageId, status: 'idle', threadIds: [] }
}

// chat id -> the video projects it's linked to, first one is the chat's main project.
// lives on the brand as brand.chatProjects
export type ChatProjects = Record<string, string[]>

// the video projects, General left out
export function videoProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.id !== GENERAL_PROJECT_ID)
}

// the projects a chat is linked to, in link order
export function chatProjectIds(brand: { projects: readonly Project[]; chatProjects?: ChatProjects }, threadId: string | null): string[] {
  if (!threadId) return []
  const ids = brand.chatProjects?.[threadId] ?? []
  return ids.filter((id) => brand.projects.some((p) => p.id === id))
}

// the project a chat's files and runs go to: its first linked one, General when it has none
export function mainProjectId(brand: { projects: readonly Project[]; chatProjects?: ChatProjects }, threadId: string | null): string {
  return chatProjectIds(brand, threadId)[0] ?? GENERAL_PROJECT_ID
}

// the same from a project list alone, through the threadIds copy. General when none lists it
export function projectIdForThread(projects: readonly Project[], threadId: string): string {
  return projects.find((p) => p.id !== GENERAL_PROJECT_ID && p.threadIds.includes(threadId))?.id ?? GENERAL_PROJECT_ID
}

// links a chat to projects, unlinks it, or replaces its links. ids that aren't video projects are dropped
export function withChatProjects(
  links: ChatProjects | undefined,
  projects: readonly Project[],
  threadId: string,
  ids: readonly string[],
  mode: 'add' | 'remove' | 'set'
): ChatProjects {
  const known = new Set(videoProjects(projects).map((p) => p.id))
  const now = (links?.[threadId] ?? []).filter((id) => known.has(id))
  const want = ids.filter((id) => known.has(id))
  const next =
    mode === 'set' ? [...new Set(want)] : mode === 'add' ? [...new Set([...now, ...want])] : now.filter((id) => !want.includes(id))
  const out = { ...links }
  if (next.length) out[threadId] = next
  else delete out[threadId]
  return out
}

export interface WorkspaceApi {
  getPipeline(brandId: string): Promise<PipelineStage[]>
  // resolves to the pipeline as saved, after cleaning
  setPipeline(brandId: string, stages: PipelineStage[]): Promise<PipelineStage[]>
  listProjects(brandId: string): Promise<Project[]>
  // adds it, or replaces the one with the same id
  saveProject(brandId: string, project: Project): Promise<Project[]>
  // links a chat to one more project, it stays linked to the others
  linkThread(brandId: string, projectId: string, threadId: string): Promise<void>
  // replaces the chat's project links
  setChatProjects(brandId: string, threadId: string, projectIds: string[]): Promise<void>
}

// what the preload exposes as window.trenddeckWorkspace
export interface WorkspaceBridge extends WorkspaceApi {
  // main changed trenddeck.json itself, e.g. an agent edited the pipeline. the renderer swaps its copy
  onDataChanged(fn: (data: AppData) => void): () => void
}

// a long running thing the sidebar's Jobs strip shows, e.g. a render or an upload. nothing feeds
// it yet, the pipeline runner is meant to
export interface JobInfo {
  id: string
  label: string
  // 0 to 1, null when it can't tell
  progress: number | null
  status: 'running' | 'done' | 'error'
}
