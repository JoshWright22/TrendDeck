import type { Checkpoint, BatchResult, BatchStep, ChangeSource, CommandResult } from './session'
import type { Id, Project } from './model'
import type { ProjectPatch } from './sync'
import type { Tick } from './time'

// the contract between the main process editor host and the renderer. main owns every open
// session; the renderer sends commands and keeps a mirror updated from change events

export const EDITOR_CHANNELS = {
  list: 'editor:list',
  create: 'editor:create',
  open: 'editor:open',
  close: 'editor:close',
  save: 'editor:save',
  snapshot: 'editor:snapshot',
  execute: 'editor:execute',
  batch: 'editor:batch',
  undo: 'editor:undo',
  redo: 'editor:redo',
  checkpoint: 'editor:checkpoint',
  revert: 'editor:revert',
  importMedia: 'editor:import-media',
  renderFrame: 'editor:render-frame',
  waveform: 'editor:waveform',
  thumbnails: 'editor:thumbnails',
  makeProxy: 'editor:make-proxy',
  exportStart: 'editor:export-start',
  exportCancel: 'editor:export-cancel',
  recoverable: 'editor:recoverable',
  recover: 'editor:recover',
  // main -> renderer events
  changed: 'editor:changed',
  exportProgress: 'editor:export-progress'
} as const

export interface EditorStatus {
  projectId: Id
  filePath: string | null
  version: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface EditorSnapshot extends EditorStatus {
  project: Project
  checkpoints: Checkpoint[]
}

export interface EditorChangeEvent extends EditorStatus {
  patch: ProjectPatch
  source: ChangeSource
  label: string
}

export type ExportPresetId = 'youtube_1080p' | 'vertical_1080x1920' | 'square_1080'

export interface ExportProgress {
  jobId: Id
  // 0..1
  progress: number
  state: 'running' | 'done' | 'failed' | 'cancelled'
  outputPath: string
  error?: string
  warnings?: string[]
}

export interface WaveformData {
  // peaks per second of media
  rate: number
  // interleaved min,max pairs in -1..1
  peaks: Float32Array
}

export interface ThumbnailStrip {
  // PNG sprite, tiles left to right
  png: Uint8Array
  tileWidth: number
  tileHeight: number
  // media time of each tile
  times: Tick[]
}

export interface RecoverableProject {
  projectId: Id
  name: string
  filePath: string | null
  journalAt: number
}

// what preload exposes as window.api.editor
export interface EditorBridge {
  list(): Promise<EditorStatus[]>
  create(name?: string): Promise<EditorSnapshot>
  open(filePath: string): Promise<EditorSnapshot>
  close(projectId: Id, opts?: { discard?: boolean }): Promise<void>
  save(projectId: Id, filePath?: string): Promise<{ filePath: string }>
  snapshot(projectId: Id): Promise<EditorSnapshot>
  execute(projectId: Id, commandId: string, args?: unknown): Promise<CommandResult>
  batch(projectId: Id, steps: BatchStep[], opts?: { label?: string; stopOnError?: boolean }): Promise<BatchResult>
  undo(projectId: Id): Promise<boolean>
  redo(projectId: Id): Promise<boolean>
  checkpoint(projectId: Id, label: string): Promise<Id>
  revert(projectId: Id, checkpointId: Id): Promise<CommandResult>
  importMedia(projectId: Id, paths: string[], binId?: Id): Promise<CommandResult[]>
  renderFrame(projectId: Id, sequenceId: Id, tick: Tick, opts?: { maxWidth?: number }): Promise<Uint8Array>
  waveform(projectId: Id, mediaId: Id): Promise<WaveformData>
  thumbnails(projectId: Id, mediaId: Id, count: number, height?: number): Promise<ThumbnailStrip>
  makeProxy(projectId: Id, mediaId: Id): Promise<CommandResult>
  exportStart(projectId: Id, sequenceId: Id, preset: ExportPresetId, outputPath: string): Promise<{ jobId: Id }>
  exportCancel(jobId: Id): Promise<void>
  recoverable(): Promise<RecoverableProject[]>
  recover(projectId: Id): Promise<EditorSnapshot>
  onChanged(fn: (e: EditorChangeEvent) => void): () => void
  onExportProgress(fn: (e: ExportProgress) => void): () => void
}
