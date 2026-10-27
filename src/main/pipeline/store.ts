import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { Pipeline, PipelineChanged, PipelineStage, Run, RunChanged, RunInput } from '@shared/pipeline'
import { broadcast } from '../gateway/wait'
import { cleanRun, cleanStages, defaultStages, newRun, syncRun } from './model'
import { readBrandPipeline, writeBrandPipeline } from '../workspace'

// the stages are brand.pipeline in trenddeck.json, the one copy the ui also reads. they're written
// through main/workspace, which pushes the saved data to the renderer so its next whole-file save
// keeps the change. runs live here, one file per brand, pipeline/<brand>.json, so an agent moving
// a run along never touches trenddeck.json
const MAX_RUNS = 500

interface BrandFile {
  version: 1
  // filled from the brand on every load, never written to this file
  stages: PipelineStage[]
  updatedAt: number
  runs: Run[]
}

const cache = new Map<string, BrandFile>()
const queues = new Map<string, Promise<unknown>>()

const dir = (): string => join(app.getPath('userData'), 'pipeline')
const file = (brandId: string): string => join(dir(), `${brandId}.json`)

function checkId(brandId: string): void {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
}

function brandStages(brandId: string): PipelineStage[] {
  try {
    return readBrandPipeline(brandId)
  } catch {
    // brand gone or data not loaded yet
    return defaultStages()
  }
}

async function load(brandId: string): Promise<BrandFile> {
  const hit = cache.get(brandId)
  if (hit) {
    hit.stages = brandStages(brandId)
    return hit
  }
  let raw: Partial<BrandFile> = {}
  try {
    raw = JSON.parse(await fs.readFile(file(brandId), 'utf8')) as Partial<BrandFile>
  } catch {
    // a brand that never had a pipeline starts with the defaults
  }
  const out: BrandFile = {
    version: 1,
    stages: brandStages(brandId),
    updatedAt: Number(raw.updatedAt) || 0,
    runs: Array.isArray(raw.runs)
      ? raw.runs.map((r) => cleanRun(r, brandId)).filter((r): r is Run => r !== null).slice(0, MAX_RUNS)
      : []
  }
  cache.set(brandId, out)
  return out
}

// one change at a time per brand, written through a temp file
function change<T>(brandId: string, fn: (f: BrandFile) => T): Promise<T> {
  checkId(brandId)
  const run = async (): Promise<T> => {
    const f = await load(brandId)
    const out = fn(f)
    f.runs = f.runs.slice(0, MAX_RUNS)
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(`${file(brandId)}.tmp`, JSON.stringify({ version: f.version, updatedAt: f.updatedAt, runs: f.runs }), 'utf8')
    await fs.rename(`${file(brandId)}.tmp`, file(brandId))
    return out
  }
  const next = (queues.get(brandId) ?? Promise.resolve()).then(run, run)
  queues.set(brandId, next.catch(() => {}))
  return next
}

const pipelineOf = (brandId: string, f: BrandFile): Pipeline => ({ brandId, stages: f.stages, updatedAt: f.updatedAt })

export async function getPipeline(brandId: string): Promise<Pipeline> {
  checkId(brandId)
  await queues.get(brandId)
  return structuredClone(pipelineOf(brandId, await load(brandId)))
}

export async function setStages(brandId: string, raw: unknown): Promise<Pipeline> {
  const stages = cleanStages(raw)
  if (!stages.length) throw new Error('a pipeline needs at least one stage')
  checkId(brandId)
  const saved = await writeBrandPipeline(brandId, stages)
  const p = await change(brandId, (f) => {
    f.stages = saved
    f.updatedAt = Date.now()
    f.runs = f.runs.map((r) => syncRun(r, stages))
    return structuredClone(pipelineOf(brandId, f))
  })
  broadcast('pipeline:changed', { brandId, pipeline: p } satisfies PipelineChanged)
  return p
}

export async function listRuns(brandId: string, opts: { projectId?: string; archived?: boolean } = {}): Promise<Run[]> {
  checkId(brandId)
  await queues.get(brandId)
  const f = await load(brandId)
  return f.runs
    .filter((r) => (opts.projectId === undefined || r.projectId === opts.projectId) && (opts.archived === undefined || r.archived === opts.archived))
    .map((r) => structuredClone(syncRun(r, f.stages)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getRun(brandId: string, runId: string): Promise<Run | null> {
  checkId(brandId)
  await queues.get(brandId)
  const f = await load(brandId)
  const r = f.runs.find((x) => x.id === runId)
  return r ? structuredClone(syncRun(r, f.stages)) : null
}

export async function createRun(brandId: string, input: RunInput): Promise<Run> {
  const run = await change(brandId, (f) => {
    const r = newRun(randomUUID(), brandId, f.stages, input)
    f.runs.unshift(r)
    return structuredClone(r)
  })
  broadcast('run:changed', { brandId, run } satisfies RunChanged)
  return run
}

// fn gets the run synced with the stages and returns the new one, or throws
export async function updateRun(
  brandId: string,
  runId: string,
  fn: (run: Run, stages: PipelineStage[]) => Run
): Promise<Run | null> {
  const run = await change(brandId, (f) => {
    const i = f.runs.findIndex((x) => x.id === runId)
    if (i < 0) return null
    const next = cleanRun(fn(syncRun(structuredClone(f.runs[i]), f.stages), f.stages), brandId)
    if (!next) return null
    next.updatedAt = Date.now()
    f.runs[i] = next
    return structuredClone(next)
  })
  if (run) broadcast('run:changed', { brandId, run } satisfies RunChanged)
  return run
}

export async function removeRun(brandId: string, runId: string): Promise<void> {
  const gone = await change(brandId, (f) => {
    const r = f.runs.find((x) => x.id === runId)
    f.runs = f.runs.filter((x) => x.id !== runId)
    return r ?? null
  })
  if (gone) broadcast('run:changed', { brandId, run: gone, removed: true } satisfies RunChanged)
}

export async function dropPipeline(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await queues.get(brandId)
  cache.delete(brandId)
  await fs.rm(file(brandId), { force: true })
}
