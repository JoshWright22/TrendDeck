import { promises as fs, type Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { allLines, parseMarkdown } from '@shared/script'
import type { TextSource } from '@shared/content-map'
import type { SpokenWord } from '@shared/speech'
import type { TakeCard } from '@shared/cards'
import { parseCues, type TimedLine } from './retention'

// what TrendDeck's own project folders know about a video: the script, caption files with
// times, takes with word times and whether there's an export. read only, a project's folder is
// never made here. plain node fs so tests run it on a temp folder

export interface LocalInfo {
  projectId: string
  name: string
  createdAt: number
  script: string[]
  // caption cues from the export first (they match the final cut), take lines after
  lines: TimedLine[]
  words: SpokenWord[]
  wordsSource: TextSource
  exportAt: number | null
  thumbnailText: string
}

const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const MAX_FILES = 80

async function walk(dir: string, depth: number, out: { path: string; name: string; mtime: number }[]): Promise<void> {
  if (depth > 3 || out.length >= MAX_FILES) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, depth + 1, out)
    else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase()
      if (ext === '.srt' || ext === '.vtt' || VIDEO.has(ext) || /^thumbnail\.txt$/i.test(e.name)) {
        const st = await fs.stat(full).catch(() => null)
        if (st && st.size < 64 * 1024 * 1024 * 1024) out.push({ path: full, name: e.name, mtime: st.mtimeMs })
      }
    }
  }
}

export async function readLocal(project: { id: string; name: string; createdAt: number }, folder: string | null, takes: TakeCard[]): Promise<LocalInfo> {
  const info: LocalInfo = { projectId: project.id, name: project.name, createdAt: project.createdAt, script: [], lines: [], words: [], wordsSource: '', exportAt: null, thumbnailText: '' }
  if (folder) {
    try {
      const s = parseMarkdown(await fs.readFile(join(folder, 'scripts', 'script.md'), 'utf8'))
      info.script = allLines(s).map((l) => l.text).filter(Boolean)
    } catch {
      // no script
    }
    const files: { path: string; name: string; mtime: number }[] = []
    await walk(folder, 0, files)
    // the newest caption file, exports are usually newer than takes' captions
    const caps = files.filter((f) => /\.(srt|vtt)$/i.test(f.name)).sort((a, b) => b.mtime - a.mtime)
    for (const c of caps.slice(0, 1)) {
      try {
        info.lines = parseCues(await fs.readFile(c.path, 'utf8'))
      } catch {
        // unreadable
      }
    }
    const exports = files.filter((f) => VIDEO.has(extname(f.name).toLowerCase()) && /export|render|final/i.test(f.path.slice(folder.length)))
    if (exports.length) info.exportAt = Math.max(...exports.map((f) => f.mtime))
    const thumb = files.find((f) => /^thumbnail\.txt$/i.test(f.name))
    if (thumb) info.thumbnailText = (await fs.readFile(thumb.path, 'utf8').catch(() => '')).trim().slice(0, 200)
  }
  // the newest transcribed take of this project
  const take = takes
    .filter((t) => t.projectId === project.id && t.state === 'ready' && t.transcript && t.transcript.words.length)
    .sort((a, b) => b.at - a.at)[0]
  if (take?.transcript) {
    info.words = take.transcript.words
    info.wordsSource = 'take'
    if (!info.lines.length && take.diff) {
      info.lines = take.diff.lines
        .filter((l) => l.from !== null && l.to !== null)
        .map((l) => ({ text: l.text, from: l.from as number, to: l.to as number, source: 'script' as TextSource }))
    }
  }
  return info
}
