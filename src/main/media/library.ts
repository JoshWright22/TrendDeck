import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import {
  isMediaExt,
  kindOf,
  type AddResult,
  type MediaEdit,
  type MediaInfo,
  type MediaItem,
  type MediaLibrary,
  type MediaPost,
  type MediaProbe,
  type WatchFolder
} from '@shared/media'

// removed items wait here so undo works, copied files are only deleted once this runs out
const UNDO_MS = 2 * 60 * 1000
const MAX_FOLDER_FILES = 5000

interface Trashed {
  item: MediaItem
  removedAt: number
}

interface Stored extends MediaLibrary {
  trash: Trashed[]
  // paths removed from a watch folder, so a rescan doesn't bring them back
  ignored: string[]
}

export function mediaRoot(): string {
  return join(app.getPath('userData'), 'media')
}

function libFile(brandId: string): string {
  return join(mediaRoot(), `${brandId}.json`)
}

export function brandDir(brandId: string): string {
  return join(mediaRoot(), brandId)
}

export function thumbPath(brandId: string, id: string): string {
  return join(brandDir(brandId), 'thumbs', `${id}.jpg`)
}

export function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

// windows paths compare without case
export function pathKey(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function strs(v: unknown, max: number, count = 50): string[] {
  return Array.isArray(v)
    ? [...new Set(v.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, max)))]
        .filter(Boolean)
        .slice(0, count)
    : []
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null
}

export function cleanPlatform(p: unknown): string {
  const s = str(p, 40).trim().toLowerCase()
  return /^[a-z0-9][a-z0-9 ._-]*$/.test(s) ? s : ''
}

function cleanPost(raw: unknown): MediaPost | null {
  const p = raw as Partial<MediaPost> | null
  const platform = cleanPlatform(p?.platform)
  if (!p || !platform) return null
  const url = str(p.url, 2000)
  return { platform, at: Number(p.at) || 0, url: /^https?:\/\//.test(url) ? url : '' }
}

function cleanItem(raw: unknown, brandId: string): MediaItem | null {
  const m = raw as Partial<MediaItem> | null
  if (!m || !validId(m.id) || typeof m.path !== 'string' || !m.path) return null
  const ext = str(m.ext, 12).toLowerCase()
  return {
    id: m.id,
    brandId,
    name: str(m.name, 200) || basename(m.path),
    kind: kindOf(ext),
    ext,
    size: num(m.size) ?? 0,
    duration: num(m.duration),
    width: num(m.width),
    height: num(m.height),
    tags: strs(m.tags, 40),
    collections: strs(m.collections, 60),
    addedAt: Number(m.addedAt) || 0,
    posts: Array.isArray(m.posts) ? m.posts.map(cleanPost).filter((p): p is MediaPost => !!p) : [],
    agentAllowed: m.agentAllowed !== false,
    missing: m.missing === true,
    path: m.path,
    copied: m.copied === true,
    watchId: validId(m.watchId) ? m.watchId : '',
    hasThumb: m.hasThumb === true,
    probed: m.probed === true
  }
}

function cleanWatch(raw: unknown): WatchFolder | null {
  const w = raw as Partial<WatchFolder> | null
  if (!w || !validId(w.id) || typeof w.path !== 'string' || !w.path) return null
  return { id: w.id, path: w.path, agentAllowed: w.agentAllowed === true, addedAt: Number(w.addedAt) || 0 }
}

function cleanLib(raw: unknown, brandId: string): Stored {
  const d = (raw ?? {}) as Partial<Stored>
  const items = Array.isArray(d.items)
    ? d.items.map((i) => cleanItem(i, brandId)).filter((i): i is MediaItem => !!i)
    : []
  const trash = Array.isArray(d.trash)
    ? d.trash
        .map((t) => {
          const item = cleanItem(t?.item, brandId)
          return item ? { item, removedAt: Number(t.removedAt) || 0 } : null
        })
        .filter((t): t is Trashed => !!t)
    : []
  return {
    brandId,
    items,
    collections: strs(d.collections, 60, 200),
    watch: Array.isArray(d.watch) ? d.watch.map(cleanWatch).filter((w): w is WatchFolder => !!w) : [],
    copyByDefault: d.copyByDefault === true,
    trash,
    ignored: strs(d.ignored, 1000, 20000)
  }
}

const libs = new Map<string, Stored>()
const loading = new Map<string, Promise<Stored>>()
const queues = new Map<string, Promise<void>>()
let changed: (brandId: string) => void = () => {}

export function onLibraryChange(fn: (brandId: string) => void): void {
  changed = fn
}

export async function getLib(brandId: string): Promise<Stored> {
  if (!validId(brandId)) throw new Error('bad brand id')
  const have = libs.get(brandId)
  if (have) return have
  let p = loading.get(brandId)
  if (!p) {
    p = (async () => {
      let lib: Stored
      try {
        lib = cleanLib(JSON.parse(await fs.readFile(libFile(brandId), 'utf8')), brandId)
      } catch {
        lib = cleanLib(null, brandId)
      }
      libs.set(brandId, lib)
      loading.delete(brandId)
      return lib
    })()
    loading.set(brandId, p)
  }
  return p
}

// every brand that has a library file, for watch folders on startup and id lookups
export async function loadAllLibs(): Promise<Stored[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(mediaRoot())
  } catch {
    return []
  }
  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(validId)
  return Promise.all(ids.map(getLib))
}

export function loadedLibs(): Stored[] {
  return [...libs.values()]
}

// same temp file and queue trick as the main store
export function saveLib(lib: Stored): Promise<void> {
  const run = async (): Promise<void> => {
    await fs.mkdir(mediaRoot(), { recursive: true })
    const file = libFile(lib.brandId)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(lib, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }
  const prev = queues.get(lib.brandId) ?? Promise.resolve()
  const next = prev.then(run, run)
  queues.set(lib.brandId, next)
  changed(lib.brandId)
  return next
}

export function publicLib(lib: Stored): MediaLibrary {
  return {
    brandId: lib.brandId,
    items: lib.items,
    collections: lib.collections,
    watch: lib.watch,
    copyByDefault: lib.copyByDefault
  }
}

// strip everything that points at the disk
export function toInfo(m: MediaItem): MediaInfo {
  return {
    id: m.id,
    brandId: m.brandId,
    name: m.name,
    kind: m.kind,
    ext: m.ext,
    size: m.size,
    duration: m.duration,
    width: m.width,
    height: m.height,
    tags: [...m.tags],
    collections: [...m.collections],
    addedAt: m.addedAt,
    posts: m.posts.map((p) => ({ ...p })),
    agentAllowed: m.agentAllowed,
    missing: m.missing
  }
}

export async function findItem(id: string): Promise<MediaItem | null> {
  if (!validId(id)) return null
  await loadAllLibs()
  for (const lib of libs.values()) {
    const item = lib.items.find((i) => i.id === id)
    if (item) return item
  }
  return null
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 8 || out.length >= MAX_FOLDER_FILES) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FOLDER_FILES) return
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out, depth + 1)
    else if (e.isFile() && isMediaExt(extname(e.name).slice(1))) out.push(full)
  }
}

// folders only bring in media files, a single file can be anything
export async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    try {
      const st = await fs.stat(p)
      if (st.isDirectory()) await walk(p, out, 0)
      else if (st.isFile()) out.push(p)
    } catch {
      // gone already, skip it
    }
  }
  return out
}

async function copyInto(lib: Stored, item: MediaItem): Promise<void> {
  const dir = join(brandDir(lib.brandId), 'files')
  await fs.mkdir(dir, { recursive: true })
  const dest = join(dir, `${item.id}${item.ext ? `.${item.ext}` : ''}`)
  await fs.copyFile(item.path, dest)
  item.path = dest
  item.copied = true
  item.missing = false
}

interface AddOpts {
  watch?: WatchFolder
  copy?: boolean
}

export async function addFiles(brandId: string, paths: string[], opts: AddOpts = {}): Promise<AddResult> {
  const lib = await getLib(brandId)
  const files = await expandPaths(paths)
  const have = new Map(lib.items.map((i) => [pathKey(i.path), i.id]))
  const ignored = new Set(lib.ignored)
  let added = 0
  let skipped = 0
  const ids: string[] = []
  for (const file of files) {
    const key = pathKey(file)
    const known = have.get(key)
    if (known || (opts.watch && ignored.has(key))) {
      if (known) ids.push(known)
      skipped++
      continue
    }
    let size = 0
    try {
      size = (await fs.stat(file)).size
    } catch {
      skipped++
      continue
    }
    const ext = extname(file).slice(1).toLowerCase()
    const item: MediaItem = {
      id: randomUUID(),
      brandId,
      name: basename(file, extname(file)),
      kind: kindOf(ext),
      ext,
      size,
      duration: null,
      width: null,
      height: null,
      tags: [],
      collections: [],
      addedAt: Date.now(),
      posts: [],
      // picked by hand means yes, a watch folder follows its own switch
      agentAllowed: opts.watch ? opts.watch.agentAllowed : true,
      missing: false,
      path: resolve(file),
      copied: false,
      watchId: opts.watch?.id ?? '',
      hasThumb: false,
      probed: kindOf(ext) === 'file'
    }
    if (opts.copy ?? lib.copyByDefault) {
      try {
        await copyInto(lib, item)
      } catch {
        skipped++
        continue
      }
    }
    lib.items.unshift(item)
    have.set(key, item.id)
    ids.push(item.id)
    added++
  }
  if (added) await saveLib(lib)
  return { added, skipped, ids }
}

export async function editItems(brandId: string, ids: string[], edit: MediaEdit): Promise<void> {
  const lib = await getLib(brandId)
  const set = new Set(ids)
  for (const item of lib.items) {
    if (!set.has(item.id)) continue
    if (typeof edit.name === 'string' && edit.name.trim()) item.name = edit.name.trim().slice(0, 200)
    if (edit.tags) item.tags = strs(edit.tags, 40)
    if (edit.collections) item.collections = strs(edit.collections, 60).filter((c) => lib.collections.includes(c))
    if (typeof edit.agentAllowed === 'boolean') item.agentAllowed = edit.agentAllowed
  }
  await saveLib(lib)
}

export async function removeItems(brandId: string, ids: string[]): Promise<void> {
  const lib = await getLib(brandId)
  const set = new Set(ids)
  const now = Date.now()
  for (const item of lib.items.filter((i) => set.has(i.id))) {
    lib.trash.push({ item, removedAt: now })
    if (item.watchId) lib.ignored.push(pathKey(item.path))
  }
  lib.items = lib.items.filter((i) => !set.has(i.id))
  await saveLib(lib)
  setTimeout(() => void purge(brandId), UNDO_MS + 1000)
}

export async function undoRemove(brandId: string, ids: string[]): Promise<void> {
  const lib = await getLib(brandId)
  const set = new Set(ids)
  const back = lib.trash.filter((t) => set.has(t.item.id)).map((t) => t.item)
  lib.trash = lib.trash.filter((t) => !set.has(t.item.id))
  const keys = new Set(back.map((i) => pathKey(i.path)))
  lib.ignored = lib.ignored.filter((k) => !keys.has(k))
  lib.items = [...back, ...lib.items].sort((a, b) => b.addedAt - a.addedAt)
  await saveLib(lib)
}

// drops trash past the undo window, only files we copied in get deleted from disk
export async function purge(brandId: string): Promise<void> {
  const lib = await getLib(brandId)
  const cutoff = Date.now() - UNDO_MS
  const old = lib.trash.filter((t) => t.removedAt < cutoff)
  if (!old.length) return
  lib.trash = lib.trash.filter((t) => t.removedAt >= cutoff)
  for (const { item } of old) {
    if (item.copied) await fs.rm(item.path, { force: true }).catch(() => {})
    await fs.rm(thumbPath(brandId, item.id), { force: true }).catch(() => {})
  }
  await saveLib(lib)
}

export async function copyItemsIn(brandId: string, ids: string[]): Promise<void> {
  const lib = await getLib(brandId)
  for (const item of lib.items) {
    if (!ids.includes(item.id) || item.copied || item.missing) continue
    // once copied the watch folder no longer owns it
    if (item.watchId) lib.ignored.push(pathKey(item.path))
    try {
      await copyInto(lib, item)
      item.watchId = ''
    } catch {
      item.missing = true
    }
  }
  await saveLib(lib)
}

export async function relinkItem(brandId: string, id: string, path: string): Promise<boolean> {
  const lib = await getLib(brandId)
  const item = lib.items.find((i) => i.id === id)
  if (!item) return false
  try {
    const st = await fs.stat(path)
    if (!st.isFile()) return false
    item.path = resolve(path)
    item.size = st.size
    item.missing = false
    item.copied = false
    await saveLib(lib)
    return true
  } catch {
    return false
  }
}

const lastCheck = new Map<string, number>()

// flags files that moved or got deleted, at most every few seconds per brand
export async function checkMissing(brandId: string, force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - (lastCheck.get(brandId) ?? 0) < 5000) return
  lastCheck.set(brandId, now)
  const lib = await getLib(brandId)
  let dirty = false
  await Promise.all(
    lib.items.map(async (item) => {
      let missing = false
      try {
        const st = await fs.stat(item.path)
        if (st.size !== item.size) {
          item.size = st.size
          dirty = true
        }
      } catch {
        missing = true
      }
      if (missing !== item.missing) {
        item.missing = missing
        dirty = true
      }
    })
  )
  if (dirty) await saveLib(lib)
}

export async function markPosted(brandId: string, id: string, platform: string, url: string): Promise<void> {
  const lib = await getLib(brandId)
  const item = lib.items.find((i) => i.id === id)
  const post = cleanPost({ platform, url, at: Date.now() })
  if (!item || !post) return
  item.posts.push(post)
  await saveLib(lib)
}

export async function unmarkPosted(brandId: string, id: string, platform: string, at: number): Promise<void> {
  const lib = await getLib(brandId)
  const item = lib.items.find((i) => i.id === id)
  if (!item) return
  item.posts = item.posts.filter((p) => !(p.platform === platform && p.at === at))
  await saveLib(lib)
}

export async function setProbe(brandId: string, id: string, probe: MediaProbe): Promise<void> {
  const lib = await getLib(brandId)
  const item = lib.items.find((i) => i.id === id)
  if (!item) return
  item.duration = num(probe?.duration)
  item.width = num(probe?.width)
  item.height = num(probe?.height)
  item.probed = true
  const prefix = 'data:image/jpeg;base64,'
  const thumb = typeof probe?.thumb === 'string' ? probe.thumb : ''
  if (thumb.startsWith(prefix) && thumb.length < 800_000) {
    const file = thumbPath(brandId, id)
    await fs.mkdir(join(brandDir(brandId), 'thumbs'), { recursive: true })
    await fs.writeFile(file, Buffer.from(thumb.slice(prefix.length), 'base64'))
    item.hasThumb = true
  }
  await saveLib(lib)
}

export async function setCollections(brandId: string, collections: string[]): Promise<void> {
  const lib = await getLib(brandId)
  lib.collections = strs(collections, 60, 200)
  for (const item of lib.items) item.collections = item.collections.filter((c) => lib.collections.includes(c))
  await saveLib(lib)
}

export async function setCopyByDefault(brandId: string, on: boolean): Promise<void> {
  const lib = await getLib(brandId)
  lib.copyByDefault = on === true
  await saveLib(lib)
}

// brand deleted, its library and copies go with it
export async function dropLib(brandId: string): Promise<void> {
  if (!validId(brandId)) return
  libs.delete(brandId)
  await fs.rm(libFile(brandId), { force: true }).catch(() => {})
  await fs.rm(brandDir(brandId), { recursive: true, force: true }).catch(() => {})
}
