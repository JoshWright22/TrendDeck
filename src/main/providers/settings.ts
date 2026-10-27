import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import { DEFAULT_PERMISSION_MODE, isPermissionMode, type PermissionMode } from '@shared/providers'

// the permission mode new threads start with, per brand. a thread's own pick lives on the thread

let cache: Record<string, PermissionMode> | null = null

function file(): string {
  return join(app.getPath('userData'), 'agent-permissions.json')
}

async function load(): Promise<Record<string, PermissionMode>> {
  if (cache) return cache
  const out: Record<string, PermissionMode> = {}
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>
    for (const [k, v] of Object.entries(raw)) if (ID_PATTERN.test(k) && isPermissionMode(v)) out[k] = v
  } catch {
    // no file yet
  }
  cache = out
  return out
}

export async function brandMode(brandId: string): Promise<PermissionMode> {
  return (await load())[brandId] ?? DEFAULT_PERMISSION_MODE
}

export async function setBrandMode(brandId: string, mode: PermissionMode): Promise<void> {
  const all = await load()
  all[brandId] = mode
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(all), 'utf8')
  await fs.rename(tmp, file())
}
