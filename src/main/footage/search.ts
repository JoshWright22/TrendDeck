import { promises as fs } from 'node:fs'
import { basename, extname, join, normalize, resolve } from 'node:path'

// finding the creator's recordings on their computer: a walk over a few likely places, newest
// first. media files only, never their contents. pure node, no electron, unit tested

export const VIDEO_EXTS = ['.mp4', '.mkv', '.mov', '.webm', '.flv', '.ts', '.m4v', '.avi']
export const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus']

export type MediaKind = 'video' | 'audio'

export function mediaKind(path: string): MediaKind | null {
  const ext = extname(path).toLowerCase()
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  return null
}

// system, app and tool folders that hold no recordings, or only game and app assets
const SKIP = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'system volume information', 'recovery', 'perflogs',
  'msocache', 'config.msi', 'windowsapps', 'xboxgames', 'steamapps', 'node_modules', 'onedrivetemp'
])

// hidden (dot folders like .git), system ($Recycle.Bin) and temp (~) folders are skipped too
export function skipFolder(name: string): boolean {
  return SKIP.has(name.toLowerCase()) || /^[.$~]/.test(name)
}

// a place to look, and how many folders down
export interface Place {
  dir: string
  depth: number
}

export interface FindOptions {
  query?: string
  since?: number
  until?: number
  kinds?: MediaKind[]
  // files looked at before stopping, every file counts, not just media
  maxFiles?: number
  budgetMs?: number
  now?: () => number
}

export interface Found {
  path: string
  size: number
  modified: number
  kind: MediaKind
  // the folder names from the place down and the file name, what the query is matched against
  names: string
}

export interface FindResult {
  // every media file that passed the date and kind filters, newest first
  all: Found[]
  // the ones the query matched, all of them when there was no query
  matched: Found[]
  examined: number
  stopped: null | 'files' | 'time'
  // places the walk didn't finish
  unfinished: string[]
}

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'my', 'from', 'in', 'on', 'to', 'for', 'all', 'footage', 'recording', 'recordings', 'video', 'videos'])

const compact = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

// the query's words, small ones left out unless that leaves nothing
export function queryWords(query: string): string[] {
  const words = query
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const kept = words.filter((w) => !STOP.has(w))
  return kept.length ? kept : words
}

// every word somewhere in the names, case and spacing don't matter ("SinkingStar" has "sinking")
export function matchesQuery(names: string, words: string[]): boolean {
  const c = compact(names)
  return words.every((w) => c.includes(w))
}

export async function findMedia(places: Place[], opts: FindOptions = {}): Promise<FindResult> {
  const now = opts.now ?? Date.now
  const started = now()
  const maxFiles = opts.maxFiles ?? 5000
  const budget = opts.budgetMs ?? 8000
  const kinds = opts.kinds?.length ? opts.kinds : (['video', 'audio'] as MediaKind[])
  const seenDirs = new Map<string, number>()
  const seenFiles = new Set<string>()
  const all: Found[] = []
  let examined = 0
  let stopped: FindResult['stopped'] = null
  const unfinished: string[] = []

  for (const place of places) {
    const root = resolve(place.dir)
    if (stopped) {
      unfinished.push(root)
      continue
    }
    // breadth first, recordings near the top of a place are found before deep ones
    const queue: { dir: string; depth: number; names: string }[] = [{ dir: root, depth: 0, names: basename(root) }]
    while (queue.length) {
      if (examined >= maxFiles) stopped = 'files'
      else if (now() - started > budget) stopped = 'time'
      if (stopped) {
        unfinished.push(root)
        break
      }
      const { dir, depth, names } = queue.shift()!
      // a folder already walked as deep or deeper is done, a shallower earlier walk isn't
      const key = dir.toLowerCase()
      const left = place.depth - depth
      if ((seenDirs.get(key) ?? -1) >= left) continue
      seenDirs.set(key, left)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const media: { path: string; kind: MediaKind; names: string }[] = []
      for (const e of entries) {
        // links and junctions can loop or lead out of the place
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          if (depth < place.depth && !skipFolder(e.name)) queue.push({ dir: join(dir, e.name), depth: depth + 1, names: `${names} ${e.name}` })
          continue
        }
        if (!e.isFile()) continue
        if (examined >= maxFiles) break
        examined++
        const kind = mediaKind(e.name)
        if (!kind || !kinds.includes(kind)) continue
        const path = join(dir, e.name)
        if (seenFiles.has(path.toLowerCase())) continue
        seenFiles.add(path.toLowerCase())
        media.push({ path, kind, names: `${names} ${e.name}` })
      }
      const stats = await Promise.all(media.map((m) => fs.stat(m.path).catch(() => null)))
      media.forEach((m, i) => {
        const st = stats[i]
        if (!st?.isFile()) return
        if (opts.since !== undefined && st.mtimeMs < opts.since) return
        if (opts.until !== undefined && st.mtimeMs > opts.until) return
        all.push({ path: m.path, size: st.size, modified: st.mtimeMs, kind: m.kind, names: m.names })
      })
    }
  }

  all.sort((a, b) => b.modified - a.modified)
  const words = opts.query ? queryWords(opts.query) : []
  const matched = words.length ? all.filter((f) => matchesQuery(f.names, words)) : all
  return { all, matched, examined, stopped, unfinished }
}

// the record folders in OBS's profile files (basic.ini): simple mode's FilePath, advanced
// mode's RecFilePath and FFFilePath. nothing else in the file is read
export function recordPathsFromIni(text: string): string[] {
  const out: string[] = []
  let section = ''
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    const s = /^\[(.+)\]$/.exec(line)
    if (s) {
      section = s[1]
      continue
    }
    const m = /^([A-Za-z]+)=(.+)$/.exec(line)
    if (!m) continue
    const want = (section === 'SimpleOutput' && m[1] === 'FilePath') || (section === 'AdvOut' && (m[1] === 'RecFilePath' || m[1] === 'FFFilePath'))
    if (want && m[2].trim()) out.push(normalize(m[2].trim()))
  }
  return out
}
