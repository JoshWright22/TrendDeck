import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

// one json per brand per kind, e.g. writer/<brand>.json and analytics/<brand>.json
export type Kind = 'writer' | 'analytics'

function file(kind: Kind, brandId: string): string {
  return join(app.getPath('userData'), kind, `${brandId}.json`)
}

export async function readJson(kind: Kind, brandId: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file(kind, brandId), 'utf8'))
  } catch {
    return null
  }
}

const queues = new Map<string, Promise<void>>()

// same temp file and queue trick as the main store so a crash can't leave half a file
export function writeJson(kind: Kind, brandId: string, value: unknown): Promise<void> {
  const path = file(kind, brandId)
  const run = async (): Promise<void> => {
    await fs.mkdir(join(app.getPath('userData'), kind), { recursive: true })
    await fs.writeFile(`${path}.tmp`, JSON.stringify(value), 'utf8')
    await fs.rename(`${path}.tmp`, path)
  }
  const next = (queues.get(path) ?? Promise.resolve()).then(run, run)
  queues.set(path, next)
  return next
}

export async function dropJson(kind: Kind, brandId: string): Promise<void> {
  await fs.rm(file(kind, brandId), { force: true })
}
