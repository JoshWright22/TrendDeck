import type { AppData } from './types'

// brand -> projects -> threads, and the pipeline each project runs through.
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
  // chat threads (agents/history.ts) that belong to it. a thread sits in at most one project
  threadIds: string[]
}

// every brand has this one. threads no other project lists count as its threads,
// so chats from before projects existed show up here without touching their files
export const GENERAL_PROJECT_ID = 'general'

export function generalProject(stageId: string, createdAt = 0): Project {
  return { id: GENERAL_PROJECT_ID, name: 'General', createdAt, stageId, status: 'idle', threadIds: [] }
}

// the project a thread belongs to, General when none lists it
export function projectIdForThread(projects: readonly Project[], threadId: string): string {
  return projects.find((p) => p.threadIds.includes(threadId))?.id ?? GENERAL_PROJECT_ID
}

export interface WorkspaceApi {
  getPipeline(brandId: string): Promise<PipelineStage[]>
  // resolves to the pipeline as saved, after cleaning
  setPipeline(brandId: string, stages: PipelineStage[]): Promise<PipelineStage[]>
  listProjects(brandId: string): Promise<Project[]>
  // adds it, or replaces the one with the same id
  saveProject(brandId: string, project: Project): Promise<Project[]>
  // moves a thread into a project, out of whichever one had it
  linkThread(brandId: string, projectId: string, threadId: string): Promise<void>
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
