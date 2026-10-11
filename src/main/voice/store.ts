import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cleanVoice, emptyVoice, type VoiceData } from '@shared/voice'

// one json per brand in voice/ next to trenddeck.json, so a big post library
// doesn't slow down every save of the main file
function dir(): string {
  return join(app.getPath('userData'), 'voice')
}

function file(brandId: string): string {
  return join(dir(), `${brandId}.json`)
}

const cache = new Map<string, VoiceData>()
const queues = new Map<string, Promise<void>>()
// deleted brands, so a late save from the page can't bring the file back
const dropped = new Set<string>()

export async function loadVoice(brandId: string): Promise<VoiceData> {
  const hit = cache.get(brandId)
  if (hit) return hit
  let data: VoiceData
  try {
    data = cleanVoice(JSON.parse(await fs.readFile(file(brandId), 'utf8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // keep a broken file around instead of wiping it
      await fs.rename(file(brandId), `${file(brandId)}.broken-${Date.now()}`).catch(() => {})
    }
    data = emptyVoice()
  }
  cache.set(brandId, data)
  return data
}

export function saveVoice(brandId: string, raw: unknown): Promise<void> {
  if (dropped.has(brandId)) return Promise.resolve()
  const data = cleanVoice(raw)
  cache.set(brandId, data)
  const run = async (): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${file(brandId)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fs.rename(tmp, file(brandId))
  }
  const next = (queues.get(brandId) ?? Promise.resolve()).then(run, run)
  queues.set(brandId, next)
  return next
}

export async function dropVoice(brandId: string): Promise<void> {
  dropped.add(brandId)
  cache.delete(brandId)
  await (queues.get(brandId) ?? Promise.resolve()).catch(() => {})
  queues.delete(brandId)
  await fs.rm(file(brandId), { force: true })
}
