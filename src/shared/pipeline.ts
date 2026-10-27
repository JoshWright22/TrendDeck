// the brand's content pipeline and the runs going through it. shared by main, preload and the ui
import type { DiffLine } from './gateway'

export const STAGE_KINDS = [
  'research',
  'ideate',
  'script',
  'produce',
  'edit',
  'review',
  'schedule',
  'publish',
  'engage',
  'analyze',
  'custom'
] as const
export type StageKind = (typeof STAGE_KINDS)[number]

// which workspace the ui shows for a stage
export const WORKSPACES = [
  'chat',
  'trends',
  'ideas',
  'writer',
  'voice',
  'media',
  'schedule',
  'posting',
  'shorts',
  'inbox',
  'analytics',
  'browser',
  'phone'
] as const
export type Workspace = (typeof WORKSPACES)[number]

export type StageConfig = Record<string, string | number | boolean>

export interface PipelineStage {
  id: string
  label: string
  kind: StageKind
  workspace: Workspace
  config: StageConfig
  // the agent may move past this stage without asking the user
  auto: boolean
}

export interface Pipeline {
  brandId: string
  stages: PipelineStage[]
  updatedAt: number
}

export const STAGE_STATUSES = ['pending', 'running', 'waiting_user', 'done', 'skipped'] as const
export type StageStatus = (typeof STAGE_STATUSES)[number]

export interface StageState {
  status: StageStatus
  notes: string
  // ids of things made in this stage: idea, draft, media, post, schedule slot ids
  artifacts: string[]
  updatedAt: number
}

export interface Run {
  id: string
  // the project this run is for, '' when it isn't tied to one
  projectId: string
  brandId: string
  title: string
  // null once every stage is done or skipped
  currentStageId: string | null
  stageStates: Record<string, StageState>
  createdAt: number
  updatedAt: number
  archived: boolean
}

// one change in a proposal
export type PipelineChange =
  | { op: 'add'; stage: Omit<PipelineStage, 'id'> & { id?: string }; index?: number }
  | { op: 'remove'; stageId: string }
  | { op: 'move'; stageId: string; index: number }
  | { op: 'configure'; stageId: string; patch: Partial<Omit<PipelineStage, 'id'>> }

export interface PipelineDiff {
  before: PipelineStage[]
  after: PipelineStage[]
  lines: DiffLine[]
}

// main -> renderer on 'pipeline:changed'
export interface PipelineChanged {
  brandId: string
  pipeline: Pipeline
}

// main -> renderer on 'run:changed'
export interface RunChanged {
  brandId: string
  run: Run
  // true when it was deleted
  removed?: boolean
}

// ask_user, same shape as the chat's ```trenddeck question card
export interface QuestionItem {
  question: string
  options: { label: string; description: string }[]
  multi: boolean
}

// main -> renderer on 'pipeline:question'
export interface PipelineQuestion {
  id: string
  brandId: string
  threadId: string | null
  turnId: string
  runId: string | null
  stageId: string | null
  questions: QuestionItem[]
  // every question gets an "Other" free text box
  allowOther: true
  createdAt: number
  expiresAt: number
}

// renderer -> main with 'pipeline:answer'. picks[i] is what was chosen for questions[i],
// the Other text goes in as one more string
export interface PipelineAnswer {
  id: string
  picks: string[][]
  // the user closed it without answering
  dismissed?: boolean
}

// main -> renderer on 'pipeline:question-closed'
export interface QuestionClosed {
  id: string
  reason: 'answered' | 'dismissed' | 'timeout' | 'cancelled'
}

export interface RunInput {
  projectId?: string
  title?: string
}

export interface PipelineApi {
  get(brandId: string): Promise<Pipeline>
  // the user editing their own pipeline, no approval needed
  set(brandId: string, stages: PipelineStage[]): Promise<Pipeline>
  onChanged(fn: (c: PipelineChanged) => void): () => void
  listRuns(brandId: string, opts?: { projectId?: string; archived?: boolean }): Promise<Run[]>
  getRun(brandId: string, runId: string): Promise<Run | null>
  createRun(brandId: string, input: RunInput): Promise<Run>
  updateRun(
    brandId: string,
    runId: string,
    patch: { title?: string; archived?: boolean; currentStageId?: string | null; stage?: { id: string; status?: StageStatus; notes?: string } }
  ): Promise<Run | null>
  // the user finishing the current stage by hand
  advanceRun(brandId: string, runId: string): Promise<Run | null>
  removeRun(brandId: string, runId: string): Promise<void>
  onRunChanged(fn: (c: RunChanged) => void): () => void
  pendingQuestions(): Promise<PipelineQuestion[]>
  onQuestion(fn: (q: PipelineQuestion) => void): () => void
  onQuestionClosed(fn: (c: QuestionClosed) => void): () => void
  answer(a: PipelineAnswer): Promise<boolean>
}

// the starting pipeline for a brand that never set one
export const DEFAULT_STAGES: PipelineStage[] = [
  { id: 'research', label: 'Research', kind: 'research', workspace: 'trends', config: {}, auto: true },
  { id: 'ideate', label: 'Pick an idea', kind: 'ideate', workspace: 'ideas', config: {}, auto: false },
  { id: 'script', label: 'Write', kind: 'script', workspace: 'writer', config: {}, auto: true },
  { id: 'produce', label: 'Make the media', kind: 'produce', workspace: 'media', config: {}, auto: false },
  { id: 'review', label: 'Review', kind: 'review', workspace: 'writer', config: {}, auto: false },
  { id: 'schedule', label: 'Schedule', kind: 'schedule', workspace: 'schedule', config: {}, auto: true },
  { id: 'publish', label: 'Publish', kind: 'publish', workspace: 'posting', config: {}, auto: false },
  { id: 'engage', label: 'Reply to comments', kind: 'engage', workspace: 'inbox', config: {}, auto: false },
  { id: 'analyze', label: 'Check results', kind: 'analyze', workspace: 'analytics', config: {}, auto: true }
]

declare global {
  interface Window {
    trenddeckPipeline: PipelineApi
  }
}
