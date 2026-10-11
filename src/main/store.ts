import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SITES,
  ID_PATTERN,
  isHttpUrl,
  type AppData,
  type Brand,
  type Site
} from '@shared/types'

const FILE_NAME = 'trenddeck.json'

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function defaultData(): AppData {
  const brand: Brand = {
    id: randomUUID(),
    name: 'My Brand',
    keywords: [],
    sites: DEFAULT_SITES.map((s) => ({ ...s, id: randomUUID() }))
  }
  return { version: 1, activeBrandId: brand.id, chatOpen: false, brands: [brand] }
}

function cleanSite(raw: unknown): Site | null {
  const s = raw as Partial<Site> | null
  if (!s || typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return null
  if (typeof s.name !== 'string' || typeof s.url !== 'string' || !isHttpUrl(s.url)) return null
  return { id: s.id, name: s.name.slice(0, 60), url: s.url }
}

function cleanBrand(raw: unknown): Brand | null {
  const b = raw as Partial<Brand> | null
  if (!b || typeof b.id !== 'string' || !ID_PATTERN.test(b.id)) return null
  if (typeof b.name !== 'string') return null
  const keywords = Array.isArray(b.keywords)
    ? b.keywords.filter((k): k is string => typeof k === 'string')
    : []
  const sites = Array.isArray(b.sites)
    ? b.sites.map(cleanSite).filter((s): s is Site => s !== null)
    : []
  return { id: b.id, name: b.name.slice(0, 60), keywords, sites }
}

// never trust the file or the renderer, rebuild the shape by hand
export function sanitize(raw: unknown): AppData {
  const d = raw as Partial<AppData> | null
  if (!d || !Array.isArray(d.brands)) throw new Error('bad data shape')
  const brands = d.brands.map(cleanBrand).filter((b): b is Brand => b !== null)
  const active = brands.some((b) => b.id === d.activeBrandId)
    ? (d.activeBrandId as string)
    : (brands[0]?.id ?? null)
  return { version: 1, activeBrandId: active, chatOpen: d.chatOpen === true, brands }
}

export async function loadData(): Promise<AppData> {
  const file = filePath()
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    const data = defaultData()
    await saveData(data)
    return data
  }
  try {
    return sanitize(JSON.parse(text))
  } catch {
    // keep the broken file around instead of silently wiping it
    await fs.rename(file, `${file}.broken-${Date.now()}`).catch(() => {})
    const data = defaultData()
    await saveData(data)
    return data
  }
}

let queue: Promise<void> = Promise.resolve()

// writes go through a temp file and a queue so a crash mid-save can't leave half a file
export function saveData(data: AppData): Promise<void> {
  const clean = sanitize(data)
  const run = async (): Promise<void> => {
    const file = filePath()
    const tmp = `${file}.tmp`
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }
  queue = queue.then(run, run)
  return queue
}
