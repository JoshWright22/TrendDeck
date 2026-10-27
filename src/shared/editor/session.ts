import type { CommandContext, Enabled } from './command'
import { idGenerator } from './factory'
import type { Id, Project } from './model'
import { getCommand } from './registry'
import { validate } from './schema'
import { checkProject, EditError } from './timeline'
import { TimeError } from './time'

// one open project: the current snapshot, undo history and checkpoints. snapshots are
// immutable and share structure, so keeping 200 of them costs only what each edit changed

export const HISTORY_LIMIT = 200
const CHECKPOINT_LIMIT = 50

export type CommandResult = { ok: true; result: unknown; version: number } | { ok: false; reason: string }

export interface BatchStep {
  id: string
  args?: unknown
}

export interface BatchResult {
  ok: boolean
  // per step, in order. steps after a stop are left out
  steps: CommandResult[]
  version: number
}

export type ChangeSource = 'execute' | 'batch' | 'undo' | 'redo' | 'revert' | 'load'

export interface SessionChange {
  project: Project
  prev: Project
  version: number
  label: string
  source: ChangeSource
}

export interface Checkpoint {
  id: Id
  label: string
  at: number
  version: number
}

interface Entry {
  label: string
  before: Project
  after: Project
}

export interface SessionOptions {
  newId?: (prefix: string) => Id
  now?: () => number
  historyLimit?: number
  // runs checkProject after every edit and rejects edits that break an invariant. on by default
  checkInvariants?: boolean
  // deep-freezes every snapshot so accidental mutation throws. for tests and dev
  freeze?: boolean
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

function errorReason(e: unknown): string {
  if (e instanceof EditError || e instanceof TimeError) return e.message
  return `internal error: ${e instanceof Error ? e.message : String(e)}`
}

// "$2.clipIds.0" in a batch arg is replaced by that path of step 2's result
function resolveRefs(v: unknown, results: CommandResult[]): unknown {
  if (typeof v === 'string') {
    const m = /^\$(\d+)((?:\.[\w-]+)*)$/.exec(v)
    if (!m) return v
    const step = results[Number(m[1])]
    if (!step || !step.ok) throw new EditError(`${v} points at a step that didn't succeed`)
    let cur: unknown = step.result
    for (const key of m[2].split('.').filter(Boolean)) {
      if (cur === null || typeof cur !== 'object') throw new EditError(`${v} doesn't resolve`)
      cur = (cur as Record<string, unknown>)[key]
    }
    if (cur === undefined) throw new EditError(`${v} doesn't resolve`)
    return cur
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, results))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = resolveRefs(x, results)
    return out
  }
  return v
}

export class EditorSession {
  private current: Project
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private group: { label: string; before: Project } | null = null
  private checkpointsMap = new Map<Id, Checkpoint & { project: Project }>()
  private listeners = new Set<(c: SessionChange) => void>()
  private saved: Project
  private ver = 0
  private readonly ctx: CommandContext
  private readonly limit: number
  private readonly check: boolean
  private readonly freeze: boolean

  constructor(project: Project, opts: SessionOptions = {}) {
    this.freeze = opts.freeze ?? false
    this.current = this.freeze ? deepFreeze(project) : project
    this.saved = this.current
    this.limit = opts.historyLimit ?? HISTORY_LIMIT
    this.check = opts.checkInvariants ?? true
    const fallback = idGenerator(() => null)
    const newId = opts.newId ?? fallback
    // ids must be unique across items, bins, clips and effects; random ids make clashes
    // vanishingly rare, and item and bin keys are checked outright
    this.ctx = {
      newId: (prefix) => {
        for (;;) {
          const id = newId(prefix)
          if (!(id in this.current.items) && !(id in this.current.bins)) return id
        }
      },
      now: opts.now ?? (() => Date.now())
    }
  }

  get project(): Project {
    return this.current
  }

  get version(): number {
    return this.ver
  }

  get dirty(): boolean {
    return this.current !== this.saved
  }

  markSaved(project: Project = this.current): void {
    this.saved = project
  }

  subscribe(fn: (c: SessionChange) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(next: Project, label: string, source: ChangeSource, record: boolean): void {
    const prev = this.current
    if (next === prev) return
    if (this.freeze) deepFreeze(next)
    this.current = next
    this.ver++
    if (record && !this.group) {
      this.undoStack.push({ label, before: prev, after: next })
      if (this.undoStack.length > this.limit) this.undoStack.shift()
      this.redoStack = []
    } else if (record) this.redoStack = []
    for (const fn of this.listeners) fn({ project: next, prev, version: this.ver, label, source })
  }

  // runs one command against a state without touching the session
  private apply(state: Project, id: string, args: unknown): { state: Project; result: unknown; label: string } {
    const spec = getCommand(id)
    if (!spec) throw new EditError(`unknown command ${id}`)
    const a = args ?? {}
    const bad = validate(spec.params, a)
    if (bad) throw new EditError(bad)
    if (spec.enabled) {
      const en = spec.enabled(state, a, this.ctx)
      if (en !== true) throw new EditError(en.reason)
    }
    const out = spec.run(state, a, this.ctx)
    const wrapped = 'state' in out && !('items' in out)
    const next = wrapped ? out.state : (out as Project)
    const result = wrapped ? out.result : undefined
    if (this.check && next !== state) checkProject(next)
    return { state: next, result: result ?? null, label: spec.label }
  }

  canExecute(id: string, args?: unknown): Enabled {
    try {
      this.apply(this.current, id, args)
      return true
    } catch (e) {
      return { reason: errorReason(e) }
    }
  }

  execute(id: string, args?: unknown): CommandResult {
    try {
      const r = this.apply(this.current, id, args)
      this.commit(r.state, r.label, 'execute', true)
      return { ok: true, result: r.result, version: this.ver }
    } catch (e) {
      return { ok: false, reason: errorReason(e) }
    }
  }

  // one history entry for the lot. stopOnError (default) makes it all or nothing; otherwise
  // failing steps are skipped and the rest still apply
  batch(steps: BatchStep[], opts: { label?: string; stopOnError?: boolean } = {}): BatchResult {
    const stop = opts.stopOnError ?? true
    let state = this.current
    const results: CommandResult[] = []
    let ok = true
    for (const step of steps) {
      try {
        const r = this.apply(state, step.id, resolveRefs(step.args, results))
        state = r.state
        results.push({ ok: true, result: r.result, version: this.ver })
      } catch (e) {
        ok = false
        results.push({ ok: false, reason: errorReason(e) })
        if (stop) return { ok, steps: results, version: this.ver }
      }
    }
    this.commit(state, opts.label ?? `${steps.length} edits`, 'batch', true)
    for (const r of results) if (r.ok) r.version = this.ver
    return { ok, steps: results, version: this.ver }
  }

  // everything until endGroup becomes a single undo step, e.g. one agent turn
  beginGroup(label: string): void {
    if (this.group) this.endGroup()
    this.group = { label, before: this.current }
  }

  endGroup(): void {
    const g = this.group
    if (!g) return
    this.group = null
    if (g.before === this.current) return
    this.undoStack.push({ label: g.label, before: g.before, after: this.current })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (!!this.group && this.group.before !== this.current)
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get undoLabel(): string | null {
    return this.group && this.group.before !== this.current ? this.group.label : (this.undoStack[this.undoStack.length - 1]?.label ?? null)
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null
  }

  undo(): boolean {
    this.endGroup()
    const e = this.undoStack.pop()
    if (!e) return false
    this.redoStack.push(e)
    this.commit(e.before, e.label, 'undo', false)
    return true
  }

  redo(): boolean {
    this.endGroup()
    const e = this.redoStack.pop()
    if (!e) return false
    this.undoStack.push(e)
    this.commit(e.after, e.label, 'redo', false)
    return true
  }

  history(): { undo: string[]; redo: string[] } {
    return { undo: this.undoStack.map((e) => e.label), redo: this.redoStack.map((e) => e.label).reverse() }
  }

  // remembers the current state under a label, e.g. before an agent turn starts
  checkpoint(label: string): Id {
    const id = this.ctx.newId('cp')
    this.checkpointsMap.set(id, { id, label, at: this.ctx.now(), version: this.ver, project: this.current })
    if (this.checkpointsMap.size > CHECKPOINT_LIMIT) this.checkpointsMap.delete(this.checkpointsMap.keys().next().value!)
    return id
  }

  checkpoints(): Checkpoint[] {
    return [...this.checkpointsMap.values()].map(({ id, label, at, version }) => ({ id, label, at, version }))
  }

  // goes back to a checkpoint. the revert is itself one undo step, so it can be undone too
  revertTo(checkpointId: Id): CommandResult {
    const cp = this.checkpointsMap.get(checkpointId)
    if (!cp) return { ok: false, reason: `no checkpoint ${checkpointId}` }
    this.endGroup()
    this.commit(cp.project, `Revert to ${cp.label}`, 'revert', true)
    return { ok: true, result: null, version: this.ver }
  }

  // swaps in a whole project, e.g. after loading a file or recovering a journal. clears history
  load(project: Project, opts: { saved?: boolean } = {}): void {
    this.group = null
    this.undoStack = []
    this.redoStack = []
    this.checkpointsMap.clear()
    if (opts.saved !== false) this.saved = project
    this.commit(project, 'Open', 'load', false)
  }
}

export function execute(session: EditorSession, id: string, args?: unknown): CommandResult {
  return session.execute(id, args)
}

export function batch(session: EditorSession, steps: BatchStep[], stopOnError = true): BatchResult {
  return session.batch(steps, { stopOnError })
}
