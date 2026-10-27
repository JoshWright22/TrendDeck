import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import type { GatewayPolicy } from '@shared/gateway'
import { cleanPolicy, defaultPolicy } from './decide'

// every brand's policy in gateway/policy.json, apart from trenddeck.json so the ui saving
// brand data can't change what agents may do
let cache: Record<string, GatewayPolicy> | null = null
let queue: Promise<void> = Promise.resolve()

function file(): string {
  return join(app.getPath('userData'), 'gateway', 'policy.json')
}

async function load(): Promise<Record<string, GatewayPolicy>> {
  if (cache) return cache
  const out: Record<string, GatewayPolicy> = {}
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>
    for (const [id, p] of Object.entries(raw ?? {})) if (ID_PATTERN.test(id)) out[id] = cleanPolicy(id, p)
  } catch {
    // no file yet, every brand gets the defaults
  }
  cache = out
  return out
}

function persist(all: Record<string, GatewayPolicy>): Promise<void> {
  const text = JSON.stringify(all, null, 2)
  const run = async (): Promise<void> => {
    await fs.mkdir(join(app.getPath('userData'), 'gateway'), { recursive: true })
    await fs.writeFile(`${file()}.tmp`, text, 'utf8')
    await fs.rename(`${file()}.tmp`, file())
  }
  queue = queue.then(run, run)
  return queue
}

export async function getPolicy(brandId: string): Promise<GatewayPolicy> {
  const all = await load()
  return all[brandId] ?? defaultPolicy(brandId)
}

export async function setPolicy(brandId: string, patch: unknown): Promise<GatewayPolicy> {
  const all = await load()
  const cur = all[brandId] ?? defaultPolicy(brandId)
  const p = (patch ?? {}) as Partial<GatewayPolicy>
  const next = cleanPolicy(brandId, {
    risks: { ...cur.risks, ...(p.risks ?? {}) },
    // a tool set to null goes back to its risk rule
    tools: Object.fromEntries(
      Object.entries({ ...cur.tools, ...(p.tools ?? {}) }).filter(([, v]) => v !== null && v !== undefined)
    ),
    approvalTimeoutSec: p.approvalTimeoutSec ?? cur.approvalTimeoutSec
  })
  all[brandId] = next
  await persist(all)
  return next
}

export async function dropPolicy(brandId: string): Promise<void> {
  const all = await load()
  if (!all[brandId]) return
  delete all[brandId]
  await persist(all)
}
