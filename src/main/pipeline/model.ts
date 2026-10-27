// the pipeline and run rules, no electron and no files, so scripts/gateway-test.ts can run them
import type { DiffLine } from '../../shared/gateway'
import {
  DEFAULT_STAGES,
  STAGE_KINDS,
  STAGE_STATUSES,
  MAX_STAGES,
  WORKSPACE_KEY,
  type PipelineChange,
  type PipelineStage,
  type Run,
  type StageConfig,
  type StageKind,
  type StageState,
  type StageStatus
} from '../../shared/pipeline'

export { MAX_STAGES }
const STAGE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

export class PipelineError extends Error {}

function cleanConfig(raw: unknown): StageConfig {
  const out: StageConfig = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue
    if (typeof v === 'string') out[k] = v.slice(0, 2000)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
  }
  return out
}

export function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'stage'
  )
}

export function cleanStage(raw: unknown): PipelineStage | null {
  const s = raw as Partial<PipelineStage> | null
  if (!s || typeof s.id !== 'string' || !STAGE_ID.test(s.id)) return null
  if (typeof s.label !== 'string' || !s.label.trim()) return null
  return {
    id: s.id,
    label: s.label.trim().slice(0, 60),
    kind: (STAGE_KINDS as readonly string[]).includes(s.kind as string) ? (s.kind as StageKind) : 'custom',
    workspace: typeof s.workspace === 'string' && WORKSPACE_KEY.test(s.workspace) ? s.workspace : 'none',
    config: cleanConfig(s.config),
    auto: s.auto === true
  }
}

// drops bad and repeated stages. an empty list stays empty, the store fills in defaults
export function cleanStages(raw: unknown): PipelineStage[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: PipelineStage[] = []
  for (const r of raw) {
    const s = cleanStage(r)
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
    if (out.length >= MAX_STAGES) break
  }
  return out
}

export function defaultStages(): PipelineStage[] {
  return DEFAULT_STAGES.map((s) => ({ ...s, config: { ...s.config } }))
}

function cleanState(raw: unknown): StageState {
  const s = (raw ?? {}) as Partial<StageState>
  return {
    status: (STAGE_STATUSES as readonly string[]).includes(s.status as string) ? (s.status as StageStatus) : 'pending',
    notes: typeof s.notes === 'string' ? s.notes.slice(0, 4000) : '',
    artifacts: Array.isArray(s.artifacts)
      ? [...new Set(s.artifacts.filter((a): a is string => typeof a === 'string' && ID.test(a)))].slice(0, 100)
      : [],
    updatedAt: Number(s.updatedAt) || 0
  }
}

export function cleanRun(raw: unknown, brandId: string): Run | null {
  const r = raw as Partial<Run> | null
  if (!r || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const states: Record<string, StageState> = {}
  for (const [k, v] of Object.entries((r.stageStates ?? {}) as Record<string, unknown>)) {
    if (STAGE_ID.test(k)) states[k] = cleanState(v)
  }
  return {
    id: r.id,
    projectId: typeof r.projectId === 'string' && (r.projectId === '' || ID.test(r.projectId)) ? r.projectId : '',
    brandId,
    title: typeof r.title === 'string' ? r.title.slice(0, 200) : '',
    currentStageId: typeof r.currentStageId === 'string' && STAGE_ID.test(r.currentStageId) ? r.currentStageId : null,
    stageStates: states,
    createdAt: Number(r.createdAt) || 0,
    updatedAt: Number(r.updatedAt) || 0,
    archived: r.archived === true
  }
}

const finished = (s: StageState | undefined): boolean => s?.status === 'done' || s?.status === 'skipped'

// every stage in the pipeline gets a state, and the current stage is a real one that isn't
// finished. states for removed stages stay, in case the stage comes back
export function syncRun(run: Run, stages: PipelineStage[], now = Date.now()): Run {
  const states = { ...run.stageStates }
  for (const s of stages) if (!states[s.id]) states[s.id] = { status: 'pending', notes: '', artifacts: [], updatedAt: now }
  let current = run.currentStageId
  if (!current || !stages.some((s) => s.id === current) || finished(states[current])) {
    current = stages.find((s) => !finished(states[s.id]))?.id ?? null
  }
  return { ...run, stageStates: states, currentStageId: current }
}

export function newRun(id: string, brandId: string, stages: PipelineStage[], input: { projectId?: string; title?: string }, now = Date.now()): Run {
  const run = syncRun(
    {
      id,
      projectId: input.projectId && ID.test(input.projectId) ? input.projectId : '',
      brandId,
      title: (input.title ?? '').slice(0, 200),
      currentStageId: null,
      stageStates: {},
      createdAt: now,
      updatedAt: now,
      archived: false
    },
    stages,
    now
  )
  if (run.currentStageId) run.stageStates[run.currentStageId] = { ...run.stageStates[run.currentStageId], status: 'running', updatedAt: now }
  return run
}

function addArtifacts(state: StageState, ids: string[] | undefined): string[] {
  if (!ids?.length) return state.artifacts
  return [...new Set([...state.artifacts, ...ids.filter((a) => ID.test(a))])].slice(0, 100)
}

export interface StagePatch {
  status?: StageStatus
  notes?: string
  // appended, not replaced
  artifacts?: string[]
}

export function setStage(run: Run, stages: PipelineStage[], stageId: string, patch: StagePatch, now = Date.now()): Run {
  if (!stages.some((s) => s.id === stageId)) throw new PipelineError(`no stage called ${stageId}. stages: ${stages.map((s) => s.id).join(', ')}`)
  const synced = syncRun(run, stages, now)
  const cur = synced.stageStates[stageId]
  const next: StageState = {
    status: patch.status ?? cur.status,
    notes: patch.notes !== undefined ? patch.notes.slice(0, 4000) : cur.notes,
    artifacts: addArtifacts(cur, patch.artifacts),
    updatedAt: now
  }
  const states = { ...synced.stageStates, [stageId]: next }
  // running a stage makes it the current one
  const currentStageId = patch.status === 'running' ? stageId : synced.currentStageId
  const out = syncRun({ ...synced, stageStates: states, currentStageId, updatedAt: now }, stages, now)
  // the stage the run moved on to starts running
  if (out.currentStageId && out.currentStageId !== synced.currentStageId && out.stageStates[out.currentStageId].status === 'pending') {
    out.stageStates[out.currentStageId] = { ...out.stageStates[out.currentStageId], status: 'running', updatedAt: now }
  }
  return out
}

// finishes the current stage and starts the next unfinished one, or the one asked for
export function advanceRun(
  run: Run,
  stages: PipelineStage[],
  opts: { notes?: string; artifacts?: string[]; toStageId?: string; skip?: boolean } = {},
  now = Date.now()
): Run {
  const synced = syncRun(run, stages, now)
  const from = synced.currentStageId
  if (!from) throw new PipelineError('this run is already through every stage')
  if (opts.toStageId && !stages.some((s) => s.id === opts.toStageId)) {
    throw new PipelineError(`no stage called ${opts.toStageId}. stages: ${stages.map((s) => s.id).join(', ')}`)
  }
  if (opts.toStageId === from) throw new PipelineError(`${from} is already the current stage`)
  const cur = synced.stageStates[from]
  const states: Record<string, StageState> = {
    ...synced.stageStates,
    [from]: {
      status: opts.skip ? 'skipped' : 'done',
      notes: opts.notes !== undefined ? opts.notes.slice(0, 4000) : cur.notes,
      artifacts: addArtifacts(cur, opts.artifacts),
      updatedAt: now
    }
  }
  let to: string | null
  if (opts.toStageId) {
    to = opts.toStageId
    // going back reopens that stage
    states[to] = { ...states[to], status: 'running', updatedAt: now }
  } else {
    const at = stages.findIndex((s) => s.id === from)
    to = stages.slice(at + 1).find((s) => !finished(states[s.id]))?.id ?? stages.find((s) => !finished(states[s.id]))?.id ?? null
    if (to) states[to] = { ...states[to], status: 'running', updatedAt: now }
  }
  return { ...synced, stageStates: states, currentStageId: to, updatedAt: now }
}

function sameStage(a: PipelineStage, b: PipelineStage): string[] {
  const diffs: string[] = []
  if (a.label !== b.label) diffs.push(`label: ${a.label} -> ${b.label}`)
  if (a.kind !== b.kind) diffs.push(`kind: ${a.kind} -> ${b.kind}`)
  if (a.workspace !== b.workspace) diffs.push(`workspace: ${a.workspace} -> ${b.workspace}`)
  if (a.auto !== b.auto) diffs.push(`auto: ${a.auto ? 'on' : 'off'} -> ${b.auto ? 'on' : 'off'}`)
  const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)])
  for (const k of keys) {
    if (a.config[k] !== b.config[k]) diffs.push(`${k}: ${a.config[k] ?? '(none)'} -> ${b.config[k] ?? '(none)'}`)
  }
  return diffs
}

// the longest run of ids in the same order in both lists. anything kept but not in it moved
function stayedInOrder(a: string[], b: string[]): Set<string> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = new Set<string>()
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      out.add(a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

// the before and after lists as lines for an approval card, in the after order with removed
// stages where they used to be
export function diffStages(before: PipelineStage[], after: PipelineStage[]): DiffLine[] {
  const lines: DiffLine[] = []
  const oldAt = new Map(before.map((s, i) => [s.id, i]))
  const newIds = new Set(after.map((s) => s.id))
  // a stage counts as moved when its order against the stages that stayed changed
  const inOrder = stayedInOrder(
    before.filter((s) => newIds.has(s.id)).map((s) => s.id),
    after.filter((s) => oldAt.has(s.id)).map((s) => s.id)
  )
  const removed = before.filter((s) => !newIds.has(s.id))
  const pushRemovedBefore = (oldIndex: number): void => {
    while (removed.length && (oldAt.get(removed[0].id) ?? 0) <= oldIndex) {
      const r = removed.shift()!
      lines.push({ kind: 'removed', stageId: r.id, label: r.label, detail: `was step ${(oldAt.get(r.id) ?? 0) + 1}` })
    }
  }
  after.forEach((s, i) => {
    const was = oldAt.get(s.id)
    if (was === undefined) {
      lines.push({ kind: 'added', stageId: s.id, label: s.label, detail: `step ${i + 1}, ${s.kind} in ${s.workspace}${s.auto ? ', auto' : ''}` })
      return
    }
    pushRemovedBefore(was)
    const prev = before[was]
    const moved = !inOrder.has(s.id)
    const changes = sameStage(prev, s)
    if (moved) lines.push({ kind: 'moved', stageId: s.id, label: s.label, detail: `step ${was + 1} -> ${i + 1}${changes.length ? `, ${changes.join(', ')}` : ''}` })
    else if (changes.length) lines.push({ kind: 'changed', stageId: s.id, label: s.label, detail: changes.join(', ') })
    else lines.push({ kind: 'same', stageId: s.id, label: s.label, detail: '' })
  })
  pushRemovedBefore(Infinity)
  return lines
}

// applies a proposal to a copy of the stages, or says why it can't
export function applyChanges(stages: PipelineStage[], changes: PipelineChange[]): PipelineStage[] {
  let out = stages.map((s) => ({ ...s, config: { ...s.config } }))
  const find = (id: string): number => {
    const i = out.findIndex((s) => s.id === id)
    if (i < 0) throw new PipelineError(`no stage called ${id}. stages: ${out.map((s) => s.id).join(', ') || '(none)'}`)
    return i
  }
  const clampIndex = (n: number | undefined, len: number): number =>
    n === undefined ? len : Math.max(0, Math.min(len, Math.round(n)))
  for (const c of changes) {
    if (c.op === 'add') {
      const wanted = c.stage.id ?? slug(c.stage.label ?? '')
      let id = wanted
      for (let n = 2; out.some((s) => s.id === id); n++) id = `${wanted}-${n}`
      const stage = cleanStage({ ...c.stage, id })
      if (!stage) throw new PipelineError(`stage "${c.stage.label ?? ''}" needs a label, and its id has to be lowercase letters, numbers, - or _`)
      if (out.length >= MAX_STAGES) throw new PipelineError(`a pipeline holds at most ${MAX_STAGES} stages`)
      out.splice(clampIndex(c.index, out.length), 0, stage)
    } else if (c.op === 'remove') {
      out.splice(find(c.stageId), 1)
    } else if (c.op === 'move') {
      const [s] = out.splice(find(c.stageId), 1)
      out.splice(clampIndex(c.index, out.length), 0, s)
    } else if (c.op === 'configure') {
      const i = find(c.stageId)
      const p = c.patch ?? {}
      const next = cleanStage({
        ...out[i],
        ...p,
        id: out[i].id,
        // config merges, a key set to '' is dropped
        config: Object.fromEntries(
          Object.entries({ ...out[i].config, ...((p.config ?? {}) as StageConfig) }).filter(([, v]) => v !== '')
        )
      })
      if (!next) throw new PipelineError(`that change would leave ${c.stageId} without a label`)
      out[i] = next
    } else {
      throw new PipelineError('each change needs op: add, remove, move or configure')
    }
  }
  out = cleanStages(out)
  if (out.length === 0) throw new PipelineError('a pipeline needs at least one stage')
  return out
}
