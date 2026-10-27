import { constants, createReadStream, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join, relative, resolve } from 'node:path'

export const SNAPSHOT_LIMIT = 30
const ENTRY = /^\d{13}-[0-9a-f-]{36}$/
const queues = new Map<string, Promise<unknown>>()

export function projectOperation<T>(folder: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(folder).toLowerCase()
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  queues.set(key, next)
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  }).catch(() => {})
  return next
}

async function snapshotFolder(folder: string): Promise<string> {
  let directory = await fs.realpath(folder)
  for (const name of ['.trenddeck', 'autosaves']) {
    directory = join(directory, name)
    await fs.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Craft autosave directory')
  }
  return directory
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function snapshotFile(folder: string, file: string, appId: string, reason: string): Promise<string> {
  const root = await fs.realpath(folder)
  const source = await fs.realpath(file)
  const rel = relative(root, source)
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== source) throw new Error('Craft autosave file must be inside its project')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Craft autosave needs a regular project file')
  const directory = await snapshotFolder(folder)
  const hash = await digest(source)
  for (const name of (await fs.readdir(directory)).filter((name) => ENTRY.test(name)).sort().reverse()) {
    const candidate = join(directory, name)
    const info = await fs.lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    try {
      const manifest = JSON.parse(await fs.readFile(join(candidate, 'snapshot.json'), 'utf8'))
      if (manifest.owner !== 'trenddeck-craft-autosave' || manifest.appId !== appId || manifest.file !== rel) continue
      const target = join(candidate, basename(file))
      const saved = await fs.lstat(target)
      if (manifest.hash === hash && saved.isFile() && !saved.isSymbolicLink() && await digest(target) === hash) return target
      break
    } catch {}
  }
  const newest = (await fs.readdir(directory)).filter((name) => ENTRY.test(name)).sort().at(-1)
  const at = Math.max(Date.now(), newest ? Number(newest.slice(0, 13)) + 1 : 0)
  const id = `${at}-${randomUUID()}`
  const entry = join(directory, id)
  await fs.mkdir(entry)
  const target = join(entry, basename(file))
  try {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL)
    const after = await fs.stat(source)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await digest(target) !== hash) throw new Error('Craft project changed during snapshot; retry saving')
    await fs.writeFile(join(entry, 'snapshot.json'), JSON.stringify({ owner: 'trenddeck-craft-autosave', appId, file: rel, at: Date.now(), reason, hash }), { flag: 'wx' })
  } catch (error) {
    await fs.unlink(target).catch(() => {})
    await fs.unlink(join(entry, 'snapshot.json')).catch(() => {})
    await fs.rmdir(entry).catch(() => {})
    throw error
  }
  const entries: string[] = []
  for (const name of await fs.readdir(directory)) {
    if (!ENTRY.test(name)) continue
    const candidate = join(directory, name)
    const info = await fs.lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    try {
      const manifest = JSON.parse(await fs.readFile(join(candidate, 'snapshot.json'), 'utf8'))
      const names = await fs.readdir(candidate)
      if (manifest.owner !== 'trenddeck-craft-autosave' || typeof manifest.file !== 'string') continue
      if (names.length !== 2 || !names.includes(basename(manifest.file))) continue
      const regular = await Promise.all(names.map(async (name) => {
        const stat = await fs.lstat(join(candidate, name))
        return stat.isFile() && !stat.isSymbolicLink()
      }))
      if (!regular.every(Boolean)) continue
      entries.push(name)
    } catch {}
  }
  for (const name of entries.sort().slice(0, Math.max(0, entries.length - SNAPSHOT_LIMIT))) {
    const candidate = join(directory, name)
    for (const file of await fs.readdir(candidate)) await fs.unlink(join(candidate, file))
    await fs.rmdir(candidate)
  }
  return target
}

export function periodicSave(save: () => Promise<void>, failed: (error: unknown) => void, intervalMs = 30_000): () => void {
  let stopped = false
  let timer: NodeJS.Timeout
  const schedule = (): void => {
    timer = setTimeout(() => {
      void save().catch(failed).finally(() => {
        if (!stopped) schedule()
      })
    }, intervalMs)
    timer.unref()
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
