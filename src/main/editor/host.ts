import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  createEditorToolHandler,
  createProject,
  diffProject,
  EditorSession,
  idGenerator,
  migrateProject,
  type BatchResult,
  type BatchStep,
  type CommandResult,
  type EditorChangeEvent,
  type EditorSnapshot,
  type EditorStatus,
  type ExportPresetId,
  type ExportProgress,
  type Id,
  type MediaItem,
  type RecoverableProject,
  type ThumbnailStrip,
  type Tick,
  type ToolOutput,
  type WaveformData
} from '@shared/editor'
import { exportSequence, makeProxy, probe, renderFrame, thumbnailStrip, waveformPeaks, AbortedError } from './ffmpeg'
import type { FontResolver } from './filtergraph'
import { listJournals, loadProjectFile, ProjectAutosaver, saveProjectFile } from './project-file'

// owns every open editor project in the main process. the renderer, shortcuts and agent tools
// all edit through here, so there is exactly one source of truth per project

export interface LibraryEntry {
  path: string
  name: string
  agentAllowed: boolean
}

export interface EditorHostOptions {
  // userData/editor: journals, autosaves, proxies
  dataDir: string
  fonts?: FontResolver
  // looks up a TrendDeck media library item, for agents that import by library id
  resolveLibraryItem?: (id: string) => Promise<LibraryEntry | null>
}

interface OpenProject {
  session: EditorSession
  filePath: string | null
  autosaver: ProjectAutosaver
}

export class EditorHost {
  private projects = new Map<Id, OpenProject>()
  private jobs = new Map<Id, AbortController>()
  private changeListeners = new Set<(e: EditorChangeEvent) => void>()
  private progressListeners = new Set<(e: ExportProgress) => void>()
  private waveforms = new Map<string, WaveformData>()
  private newId = idGenerator()
  activeId: Id | null = null

  constructor(private readonly opts: EditorHostOptions) {}

  onChange(fn: (e: EditorChangeEvent) => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  onExportProgress(fn: (e: ExportProgress) => void): () => void {
    this.progressListeners.add(fn)
    return () => this.progressListeners.delete(fn)
  }

  private get(projectId: Id | undefined): OpenProject {
    const id = projectId ?? this.activeId
    const op = id ? this.projects.get(id) : undefined
    if (!op) throw new Error(projectId ? `project ${projectId} is not open` : 'no editor project is open')
    return op
  }

  session(projectId?: Id): EditorSession | null {
    try {
      return this.get(projectId).session
    } catch {
      return null
    }
  }

  private status(op: OpenProject): EditorStatus {
    const s = op.session
    return {
      projectId: s.project.id,
      filePath: op.filePath,
      version: s.version,
      dirty: s.dirty,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      undoLabel: s.undoLabel,
      redoLabel: s.redoLabel
    }
  }

  private attach(session: EditorSession, filePath: string | null): OpenProject {
    const op: OpenProject = {
      session,
      filePath,
      autosaver: new ProjectAutosaver(session, { dir: this.opts.dataDir, filePath: () => op.filePath, onError: (e) => console.error('editor autosave', e) })
    }
    session.subscribe((c) => {
      const patch = diffProject(c.prev, c.project, c.version - 1, c.version)
      const e: EditorChangeEvent = { ...this.status(op), patch, source: c.source, label: c.label }
      for (const fn of this.changeListeners) fn(e)
    })
    this.projects.set(session.project.id, op)
    this.activeId = session.project.id
    return op
  }

  snapshot(projectId: Id): EditorSnapshot {
    const op = this.get(projectId)
    return { ...this.status(op), project: op.session.project, checkpoints: op.session.checkpoints() }
  }

  list(): EditorStatus[] {
    return [...this.projects.values()].map((op) => this.status(op))
  }

  create(name = 'Untitled'): EditorSnapshot {
    const project = createProject({ id: this.newId('proj'), name })
    const op = this.attach(new EditorSession(project), null)
    return this.snapshot(op.session.project.id)
  }

  async open(filePath: string): Promise<EditorSnapshot> {
    for (const op of this.projects.values()) {
      if (op.filePath === filePath) {
        this.activeId = op.session.project.id
        return this.snapshot(this.activeId)
      }
    }
    const { project } = await loadProjectFile(filePath)
    if (this.projects.has(project.id)) throw new Error('a copy of this project is already open')
    const op = this.attach(new EditorSession(project), filePath)
    return this.snapshot(op.session.project.id)
  }

  async save(projectId: Id, filePath?: string): Promise<{ filePath: string }> {
    const op = this.get(projectId)
    const target = filePath ?? op.filePath
    if (!target) throw new Error('choose where to save the project')
    const p = op.session.project
    await saveProjectFile(target, p)
    op.filePath = target
    op.session.markSaved(p)
    await op.autosaver.clearJournal()
    return { filePath: target }
  }

  async close(projectId: Id, opts: { discard?: boolean } = {}): Promise<void> {
    const op = this.get(projectId)
    if (op.session.dirty && !opts.discard) throw new Error('project has unsaved changes')
    await op.autosaver.dispose()
    this.projects.delete(projectId)
    if (this.activeId === projectId) this.activeId = this.projects.keys().next().value ?? null
  }

  // the app is quitting: keep journals of anything unsaved so it can be recovered next launch
  async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) job.abort()
    for (const op of this.projects.values()) await op.autosaver.dispose({ keepJournal: op.session.dirty })
    this.projects.clear()
  }

  async recoverable(): Promise<RecoverableProject[]> {
    const journals = await listJournals(this.opts.dataDir)
    return journals.filter((j) => !this.projects.has(j.projectId)).map((j) => ({ projectId: j.projectId, name: j.name, filePath: j.filePath, journalAt: j.at }))
  }

  async recover(projectId: Id): Promise<EditorSnapshot> {
    const j = (await listJournals(this.opts.dataDir)).find((x) => x.projectId === projectId)
    if (!j) throw new Error('nothing to recover for that project')
    const project = migrateProject(j.project)
    const session = new EditorSession(project)
    // recovered work isn't on disk yet
    session.markSaved(createProject({ id: project.id }))
    this.attach(session, j.filePath)
    return this.snapshot(project.id)
  }

  execute(projectId: Id, commandId: string, args?: unknown): CommandResult {
    return this.get(projectId).session.execute(commandId, args)
  }

  batch(projectId: Id, steps: BatchStep[], opts?: { label?: string; stopOnError?: boolean }): BatchResult {
    return this.get(projectId).session.batch(steps, opts)
  }

  undo(projectId: Id): boolean {
    return this.get(projectId).session.undo()
  }

  redo(projectId: Id): boolean {
    return this.get(projectId).session.redo()
  }

  checkpoint(projectId: Id, label: string): Id {
    return this.get(projectId).session.checkpoint(label)
  }

  revert(projectId: Id, checkpointId: Id): CommandResult {
    return this.get(projectId).session.revertTo(checkpointId)
  }

  // an agent turn: checkpoint first so the whole turn can be thrown away, one undo step after
  beginAgentTurn(projectId: Id | undefined, label: string): Id {
    const s = this.get(projectId).session
    const cp = s.checkpoint(label)
    s.beginGroup(label)
    return cp
  }

  endAgentTurn(projectId: Id | undefined): void {
    this.session(projectId)?.endGroup()
  }

  // trusted import from the app UI: probes each file and adds it
  async importMedia(projectId: Id, paths: string[], binId?: Id): Promise<CommandResult[]> {
    const s = this.get(projectId).session
    const out: CommandResult[] = []
    for (const path of paths) {
      try {
        const info = await probe(path)
        out.push(s.execute('media.import', { path, binId, info: { ...info, duration: { ticks: info.duration } } }))
      } catch (e) {
        out.push({ ok: false, reason: `${path.split(/[\\/]/).pop()}: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    return out
  }

  private media(projectId: Id, mediaId: Id): MediaItem {
    const m = this.get(projectId).session.project.items[mediaId]
    if (m?.kind !== 'media') throw new Error(`no media ${mediaId}`)
    return m
  }

  renderFrame(projectId: Id, sequenceId: Id, tick: Tick, opts: { maxWidth?: number } = {}): Promise<Buffer> {
    return renderFrame(this.get(projectId).session.project, sequenceId, tick, { fonts: this.opts.fonts, maxWidth: opts.maxWidth, useProxies: true })
  }

  async waveform(projectId: Id, mediaId: Id): Promise<WaveformData> {
    const m = this.media(projectId, mediaId)
    const hit = this.waveforms.get(m.path)
    if (hit) return hit
    const w = await waveformPeaks(m.path)
    if (this.waveforms.size > 64) this.waveforms.delete(this.waveforms.keys().next().value!)
    this.waveforms.set(m.path, w)
    return w
  }

  thumbnails(projectId: Id, mediaId: Id, count: number, height?: number): Promise<ThumbnailStrip> {
    const m = this.media(projectId, mediaId)
    return thumbnailStrip(m.proxyPath && existsSync(m.proxyPath) ? m.proxyPath : m.path, m.info, { count, height })
  }

  async makeProxy(projectId: Id, mediaId: Id): Promise<CommandResult> {
    const m = this.media(projectId, mediaId)
    if (!m.info.hasVideo || m.info.isStill) return { ok: false, reason: 'only video needs a proxy' }
    const key = createHash('sha1').update(m.path).digest('hex').slice(0, 16)
    const dst = join(this.opts.dataDir, 'proxies', `${key}.mp4`)
    if (!existsSync(dst)) await makeProxy(m.path, dst, m.info)
    return this.get(projectId).session.execute('media.set_proxy', { mediaId, proxyPath: dst })
  }

  exportStart(projectId: Id, sequenceId: Id, preset: ExportPresetId, outputPath: string): { jobId: Id } {
    const project = this.get(projectId).session.project
    const jobId = this.newId('job')
    const ac = new AbortController()
    this.jobs.set(jobId, ac)
    const emit = (e: Omit<ExportProgress, 'jobId' | 'outputPath'>): void => {
      for (const fn of this.progressListeners) fn({ jobId, outputPath, ...e })
    }
    emit({ progress: 0, state: 'running' })
    let last = 0
    exportSequence(
      project,
      sequenceId,
      preset,
      outputPath,
      (p) => {
        if (p - last < 0.01 && p < 1) return
        last = p
        emit({ progress: p, state: 'running' })
      },
      ac.signal,
      { fonts: this.opts.fonts }
    )
      .then((r) => emit({ progress: 1, state: 'done', warnings: r.warnings }))
      .catch((e) => emit({ progress: last, state: e instanceof AbortedError ? 'cancelled' : 'failed', error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.jobs.delete(jobId))
    return { jobId }
  }

  exportCancel(jobId: Id): void {
    this.jobs.get(jobId)?.abort()
  }

  // agents only get library media they're allowed to see, and never touch file paths
  private async prepareForAgent(commandId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (commandId === 'media.relink' || commandId === 'media.set_proxy') throw new Error(`${commandId} is not available to agents`)
    if (commandId !== 'media.import') return args
    const libraryId = typeof args.libraryId === 'string' ? args.libraryId : null
    if (!libraryId || !this.opts.resolveLibraryItem) throw new Error('agents import media by libraryId from the media library')
    const entry = await this.opts.resolveLibraryItem(libraryId)
    if (!entry || !entry.agentAllowed) throw new Error('that media is not shared with agents')
    const info = await probe(entry.path)
    return { ...args, path: entry.path, name: args.name ?? entry.name, info: { ...info, duration: { ticks: info.duration } } }
  }

  // MCP-style handler for the agent gateway: command_list, command_run, command_batch,
  // project_inspect, sequence_inspect. paths are redacted from everything it returns
  toolHandler(): (name: string, input: unknown) => Promise<ToolOutput> {
    return createEditorToolHandler({
      getSession: (id) => this.session(id),
      prepare: (_s, id, args) => this.prepareForAgent(id, args),
      redactPaths: true
    })
  }

  async removeProxyCache(): Promise<void> {
    await fs.rm(join(this.opts.dataDir, 'proxies'), { recursive: true, force: true })
  }
}
