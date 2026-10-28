import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cleanZoom, DEFAULT_ZOOM, type CraftWebView } from '@shared/craft-web-view'

// how each Craft app looks in the chat (its size, FilmCraft's settings and panel layout), kept
// across embeds and restarts in userData/craft-web-view.json. see @shared/craft-web-view

let views: Record<string, CraftWebView> | null = null
let writing: Promise<void> = Promise.resolve()

const file = (): string => join(app.getPath('userData'), 'craft-web-view.json')

async function load(): Promise<Record<string, CraftWebView>> {
  if (views) return views
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, Partial<CraftWebView>>
    views = {}
    for (const [id, v] of Object.entries(raw)) if (v && typeof v === 'object') views[id] = { ...v, zoom: cleanZoom(v.zoom) }
  } catch {
    views = {}
  }
  return views
}

export async function viewOf(appId: string): Promise<CraftWebView> {
  return (await load())[appId] ?? { zoom: DEFAULT_ZOOM }
}

export async function setView(appId: string, change: Partial<CraftWebView>): Promise<CraftWebView> {
  const all = await load()
  const next = { ...(all[appId] ?? { zoom: DEFAULT_ZOOM }), ...change }
  next.zoom = cleanZoom(next.zoom)
  all[appId] = next
  const data = JSON.stringify(all)
  // one write at a time, the last one wins
  writing = writing.then(async () => {
    const tmp = `${file()}.tmp`
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, file())
  }).catch((err) => console.error('craft: the editors\' layout was not saved', err))
  await writing
  return next
}
