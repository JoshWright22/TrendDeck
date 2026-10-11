import { randomUUID } from 'node:crypto'
import { watch, promises as fs, type FSWatcher } from 'node:fs'
import { extname, resolve } from 'node:path'
import { isMediaExt } from '@shared/media'
import { addFiles, expandPaths, getLib, loadAllLibs, pathKey, saveLib } from './library'

// an export still being written keeps changing size, wait until it settles
const SETTLE_MS = 4000
const RESCAN_MS = 1500

const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, NodeJS.Timeout>()

function key(brandId: string, watchId: string): string {
  return `${brandId}/${watchId}`
}

async function scan(brandId: string, watchId: string): Promise<void> {
  const lib = await getLib(brandId)
  const folder = lib.watch.find((w) => w.id === watchId)
  if (!folder) return
  const files = await expandPaths([folder.path])
  const have = new Set(lib.items.map((i) => pathKey(i.path)))
  const fresh: string[] = []
  let busy = false
  for (const file of files) {
    if (have.has(pathKey(file))) continue
    try {
      const st = await fs.stat(file)
      if (Date.now() - st.mtimeMs < SETTLE_MS) {
        busy = true
        continue
      }
    } catch {
      continue
    }
    fresh.push(file)
  }
  if (fresh.length) await addFiles(brandId, fresh, { watch: folder, copy: false })
  if (busy) later(brandId, watchId, SETTLE_MS)
}

function later(brandId: string, watchId: string, ms = RESCAN_MS): void {
  const k = key(brandId, watchId)
  clearTimeout(timers.get(k))
  timers.set(
    k,
    setTimeout(() => {
      timers.delete(k)
      void scan(brandId, watchId)
    }, ms)
  )
}

function start(brandId: string, watchId: string, path: string): void {
  const k = key(brandId, watchId)
  if (watchers.has(k)) return
  try {
    const w = watch(path, { recursive: true }, (_event, name) => {
      // only care about media, renames of other files are noise
      if (name && !isMediaExt(extname(String(name)).slice(1))) return
      later(brandId, watchId)
    })
    // folder deleted or the drive went away, the next start tries again
    w.on('error', () => stop(brandId, watchId))
    watchers.set(k, w)
  } catch {
    // folder isn't there right now
  }
  void scan(brandId, watchId)
}

function stop(brandId: string, watchId: string): void {
  const k = key(brandId, watchId)
  watchers.get(k)?.close()
  watchers.delete(k)
  clearTimeout(timers.get(k))
  timers.delete(k)
}

export async function startAllWatches(): Promise<void> {
  for (const lib of await loadAllLibs()) {
    for (const w of lib.watch) start(lib.brandId, w.id, w.path)
  }
}

export async function addWatch(brandId: string, path: string, agentAllowed = false): Promise<void> {
  const lib = await getLib(brandId)
  const full = resolve(path)
  const st = await fs.stat(full).catch(() => null)
  if (!st?.isDirectory()) return
  if (lib.watch.some((w) => pathKey(w.path) === pathKey(full))) return
  const folder = { id: randomUUID(), path: full, agentAllowed, addedAt: Date.now() }
  lib.watch.push(folder)
  await saveLib(lib)
  start(brandId, folder.id, folder.path)
}

export async function editWatch(brandId: string, watchId: string, agentAllowed: boolean): Promise<void> {
  const lib = await getLib(brandId)
  const folder = lib.watch.find((w) => w.id === watchId)
  if (!folder) return
  folder.agentAllowed = agentAllowed === true
  await saveLib(lib)
}

// files already in the library stay, they just stop being tied to the folder
export async function removeWatch(brandId: string, watchId: string): Promise<void> {
  const lib = await getLib(brandId)
  stop(brandId, watchId)
  lib.watch = lib.watch.filter((w) => w.id !== watchId)
  for (const item of lib.items) if (item.watchId === watchId) item.watchId = ''
  await saveLib(lib)
}

export function stopBrandWatches(brandId: string): void {
  for (const k of [...watchers.keys()]) {
    if (k.startsWith(`${brandId}/`)) stop(brandId, k.slice(brandId.length + 1))
  }
}
