import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, resolve } from 'node:path'
import { projectIdForThread } from '@shared/workspace'
import { projectFolder, projectsRoot } from '../craft/paths'
import { isInside } from '../craft/rules'
import { ImageResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { bool, int, list, num, obj, oneOf, str } from '../gateway/validate'
import { obsRecordFolders } from '../obs/service'
import { probe } from '../qc/ffmpeg'
import { getData } from '../store'
import { startAdd } from './add'
import { clock, contactSheet, MAX_FRAMES } from './frames'
import { findMedia, mediaKind, recordPathsFromIni, type Found, type MediaKind, type Place } from './search'

// footage on the creator's computer for the agent: find recordings (OBS's folder first), look
// inside long ones, and put the right parts in a project. finding and looking only read, adding
// links or copies into the project and never changes the original

const DEEP = 6

const settle = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((ok) => setTimeout(() => ok(fallback), ms))])

// OBS's record folders from every profile's basic.ini, for when OBS isn't running or the
// always-on profile isn't the one TrendDeck talks to
async function obsConfigFolders(): Promise<string[]> {
  const root = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'obs-studio', 'basic', 'profiles')
  const profiles = await fs.readdir(root).catch(() => [] as string[])
  const out: string[] = []
  for (const p of profiles.slice(0, 40)) {
    const text = await fs.readFile(join(root, p, 'basic.ini'), 'utf8').catch(() => '')
    out.push(...recordPathsFromIni(text))
  }
  return out
}

// other drives' top folders, a drive that doesn't answer quickly is left out
async function otherDrives(): Promise<string[]> {
  const system = parse(process.env.SystemRoot || homedir()).root.toUpperCase()
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => d !== system)
  const ok = await Promise.all(letters.map((d) => settle(fs.stat(d).then((s) => s.isDirectory()), 400, false)))
  return letters.filter((_, i) => ok[i])
}

const userPath = (name: Parameters<typeof app.getPath>[0], fallback: string): string => {
  try {
    return app.getPath(name)
  } catch {
    return join(homedir(), fallback)
  }
}

export async function defaultPlaces(brandId: string, extra?: string): Promise<{ places: Place[]; obs: string[] }> {
  const [live, config, drives] = await Promise.all([settle(obsRecordFolders(brandId), 2500, []), settle(obsConfigFolders(), 1500, []), otherDrives()])
  const videos = userPath('videos', 'Videos')
  const obs = [...new Set([...live, ...config].map((d) => resolve(d)))]
  const system = parse(process.env.SystemRoot || homedir()).root
  const places: Place[] = [
    ...(extra ? [{ dir: extra, depth: DEEP }] : []),
    ...obs.map((dir) => ({ dir, depth: DEEP })),
    // OBS's own default
    { dir: videos, depth: DEEP },
    { dir: userPath('desktop', 'Desktop'), depth: DEEP },
    { dir: userPath('downloads', 'Downloads'), depth: DEEP },
    { dir: userPath('documents', 'Documents'), depth: DEEP },
    { dir: projectsRoot(), depth: DEEP },
    ...drives.map((dir) => ({ dir, depth: 2 })),
    // folders right on the system drive, like C:\Recordings. Users is covered above
    { dir: system, depth: 1 }
  ]
  return { places, obs: obs.length ? obs : [videos] }
}

// "2026-10-20" is that local day, a full date and time is taken as it is
function parseDate(v: unknown, endOfDay: boolean, what: string): number | undefined {
  if (typeof v !== 'string') return undefined
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  const t = d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime() : Date.parse(v)
  if (!Number.isFinite(t)) throw new ToolError(`${what} should be a date like 2026-10-20 or 2026-10-20T18:30`)
  return t
}

const size = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

const local = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// a recording that changed in the last two minutes is probably still being written
const STILL_WRITING_MS = 120_000

async function describe(files: Found[], probeCount: number): Promise<Record<string, unknown>[]> {
  const out = files.map((f) => ({
    path: f.path,
    kind: f.kind,
    size: size(f.size),
    modified: local(f.modified),
    ...(Date.now() - f.modified < STILL_WRITING_MS ? { stillBeingWritten: true } : {})
  })) as Record<string, unknown>[]
  let next = 0
  const n = Math.min(probeCount, files.length)
  await Promise.all(
    Array.from({ length: Math.min(4, n) }, async () => {
      while (next < n) {
        const i = next++
        try {
          const info = await probe(files[i].path, AbortSignal.timeout(3000))
          if (info.duration) out[i].length = `${clock(info.duration)} (${Math.round(info.duration)} s)`
          if (info.width && info.height) out[i].resolution = `${info.width}x${info.height}`
        } catch {
          // a file ffprobe can't read in time is listed without them
        }
      }
    })
  )
  return out
}

function absoluteMedia(v: unknown): string {
  const p = String(v ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!isAbsolute(p)) throw new ToolError('give the full path, like C:\\Users\\you\\Videos\\clip.mkv, as footage_find lists it')
  if (!mediaKind(p)) throw new ToolError('that is not a video or audio file. footage tools only take mp4, mkv, mov, webm, flv, ts, m4v, avi, wav, mp3, m4a, flac, ogg or opus')
  return resolve(p)
}

async function existingFile(p: string): Promise<void> {
  const st = await fs.stat(p).catch(() => null)
  if (!st?.isFile()) throw new ToolError(`there's no file at ${p}. footage_find lists what's there`)
}

function projectOf(turn: Turn, projectId: unknown): { id: string; name: string } {
  const brand = getData()?.brands.find((b) => b.id === turn.brandId)
  if (!brand) throw new ToolError('this brand was deleted')
  const id = typeof projectId === 'string' && projectId ? projectId : projectIdForThread(brand.projects, turn.threadId ?? '')
  const p = brand.projects.find((x) => x.id === id)
  if (!p) throw new ToolError(`no project ${id || '(none linked to this chat)'} in this brand. projects: ${brand.projects.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}`)
  return p
}

const seconds = (description: string): ReturnType<typeof num> => num(description, 0, 1_000_000)

export const FOOTAGE_TOOLS: GatewayTool[] = [
  {
    name: 'footage_find',
    title: 'Find recordings on this computer',
    risk: 'read',
    description:
      "Searches the creator's computer for video and audio recordings, newest first: OBS's recording folder first (from OBS's settings, or its default Videos), then Videos, Desktop, Downloads, Documents, TrendDeck's projects and the top folders of other drives. " +
      'Only lists media files (mp4 mkv mov webm flv ts m4v avi wav mp3 m4a flac ogg opus) with their path, size and date, and length and resolution for the newest 30; it never opens or reads them. Skips system and app folders. ' +
      "query matches words in file and folder names. OBS names recordings by date and time, not by game, so when nothing matches you get the newest recordings instead; look inside them with footage_frames. Use since/until to narrow to when they played.",
    inputSchema: obj({
      query: str('words to look for in file and folder names, e.g. a game or project name. leave out for everything', 200, 1),
      since: str('only files changed on or after this date, like 2026-10-20 or 2026-10-20T18:00', 40, 1),
      until: str('only files changed on or before this date', 40, 1),
      kinds: list('video, audio or both. both when left out', oneOf('kind', ['video', 'audio']), 2, 1),
      folder: str('one more folder to search first, a full path', 400, 1),
      max: int('how many to list, 40 when left out', 1, 200)
    }),
    summarize: (_t, a) => (a.query ? `Look for recordings named like "${String(a.query)}"` : 'Look for recordings'),
    run: async (turn, a) => {
      let extra: string | undefined
      if (typeof a.folder === 'string') {
        const raw = a.folder.trim().replace(/^"(.*)"$/, '$1')
        if (!isAbsolute(raw)) throw new ToolError('folder should be a full path, like D:\\Recordings')
        extra = resolve(raw)
        const st = await fs.stat(extra).catch(() => null)
        if (!st?.isDirectory()) throw new ToolError(`there's no folder at ${extra}`)
      }
      const since = parseDate(a.since, false, 'since')
      const until = parseDate(a.until, true, 'until')
      const { places, obs } = await defaultPlaces(turn.brandId, extra)
      const found = await findMedia(places, { query: typeof a.query === 'string' ? a.query : undefined, since, until, kinds: a.kinds as MediaKind[] | undefined })
      const max = typeof a.max === 'number' ? a.max : 40
      const usedFallback = !!a.query && !found.matched.length && found.all.length > 0
      const pick = (usedFallback ? found.all : found.matched).slice(0, max)
      const notes: string[] = []
      if (usedFallback) {
        notes.push(`nothing is named like "${String(a.query)}", so these are the newest recordings found. OBS names files by date and time; look inside with footage_frames to find the right ones`)
      }
      if (!pick.length) notes.push('no recordings found in the places searched. ask the creator where they keep them, or search a folder they name with folder')
      const total = usedFallback ? found.all.length : found.matched.length
      if (total > pick.length) notes.push(`${total} found, showing the newest ${pick.length}. narrow with since/until or raise max`)
      if (found.stopped) {
        notes.push(
          `the search stopped early (${found.stopped === 'time' ? 'took too long' : `looked at ${found.examined} files`}). not finished: ${found.unfinished.slice(0, 8).join(', ')}. search one of them with folder`
        )
      }
      return {
        obsRecordingFolder: obs,
        files: await describe(pick, 30),
        ...(notes.length ? { note: notes.join('. ') } : {})
      }
    }
  },
  {
    name: 'footage_frames',
    title: 'Look inside a recording',
    risk: 'read',
    description:
      'A contact sheet of a recording so you can see what is in it: frames spread evenly over it (count, 12 by default) or one every few seconds (every), optionally between start and end in seconds, tiled left to right then down with the time on each. ' +
      `Up to ${MAX_FRAMES} frames a sheet, quick even on recordings many hours long. Also gives how loud the sound is around each frame. ` +
      'Start wide over the whole recording, then zoom into a stretch with start, end and every to find where the creator is playing and where they stop.',
    inputSchema: obj(
      {
        path: str('the full path of the recording, as footage_find lists it', 400, 1),
        count: int(`how many frames spread evenly, 12 when left out`, 1, MAX_FRAMES),
        every: num('one frame every this many seconds instead of count', 0.5, 86_400),
        start: seconds('from this many seconds in, 0 when left out'),
        end: seconds('up to this many seconds in, the end when left out'),
        width: int('width of each frame in pixels, 320 when left out', 160, 480),
        loudness: bool('measure the sound around each frame, true when left out')
      },
      ['path']
    ),
    summarize: (_t, a) => `Look inside ${basename(String(a.path ?? ''))}`,
    run: async (_turn, a) => {
      const path = absoluteMedia(a.path)
      await existingFile(path)
      if (mediaKind(path) !== 'video') throw new ToolError('that is an audio file, there are no frames to show')
      const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
      if (n(a.start) !== undefined && n(a.end) !== undefined && n(a.end)! <= n(a.start)!) throw new ToolError('end has to be after start')
      let sheet
      try {
        sheet = await contactSheet(path, { count: n(a.count), every: n(a.every), start: n(a.start), end: n(a.end), width: n(a.width), loudness: a.loudness !== false })
      } catch (err) {
        throw new ToolError(`couldn't make the contact sheet: ${(err as Error).message}`)
      }
      const lines = [
        `${basename(path)}, ${clock(sheet.duration)} long (${Math.round(sheet.duration)} s)${sheet.width ? `, ${sheet.width}x${sheet.height}` : ''}.`,
        `${sheet.frames.length} frames, ${sheet.columns} across and ${sheet.rows} down, left to right then down:`,
        ...sheet.frames.map((f, i) => {
          const sound = f.meanDb === null ? '' : `, sound average ${f.meanDb} dB, peak ${f.maxDb} dB`
          return `${i + 1}. ${f.at} (${f.t} s)${f.picture ? '' : ', no picture there'}${sound}`
        })
      ]
      if (sheet.loudnessWindow) lines.push(`sound is measured over ${Math.round(sheet.loudnessWindow * 10) / 10} s around each frame. an average under about -50 dB is near silence`)
      else if (a.loudness !== false) lines.push('no sound track to measure')
      if (sheet.more !== null) lines.push(`there is more, call again with start ${sheet.more} for the next frames`)
      return new ImageResult(sheet.png, lines.join('\n'))
    }
  },
  {
    name: 'footage_add',
    title: 'Add a recording to the project',
    risk: 'edit',
    description:
      "Puts a recording into the project's footage folder so the editors can use it. The whole file is linked in instantly when it's on the same drive (no extra space) and copied otherwise; with start and end in seconds only that part is cut out, which you want for long recordings. " +
      'Cuts keep every video and audio track and start at the nearest keyframe, a second or two early; set reencode for an exact cut (slower, makes an mp4). The original is never changed, moved or deleted. ' +
      'Big copies and cuts keep going in the background: if the result says it is still working, call again with the same arguments to check.',
    inputSchema: obj(
      {
        path: str('the full path of the recording, as footage_find lists it', 400, 1),
        projectId: str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100, 1),
        start: seconds('cut from this many seconds in'),
        end: seconds('cut up to this many seconds in'),
        reencode: bool('re-encode for a frame exact cut, false when left out')
      },
      ['path']
    ),
    summarize: (turn, a) => {
      const part = a.start !== undefined || a.end !== undefined ? ` from ${clock(Number(a.start ?? 0))} to ${a.end !== undefined ? clock(Number(a.end)) : 'the end'}` : ''
      let project = ''
      try {
        project = ` to ${projectOf(turn, a.projectId).name}`
      } catch {
        // the run says what's wrong
      }
      return `Add ${basename(String(a.path ?? ''))}${part}${project}`
    },
    run: async (turn, a) => {
      const src = absoluteMedia(a.path)
      await existingFile(src)
      const project = projectOf(turn, a.projectId)
      const folder = await projectFolder(turn.brandId, project.id)
      const dir = join(folder, 'footage')
      const start = typeof a.start === 'number' ? a.start : undefined
      const end = typeof a.end === 'number' ? a.end : undefined
      if (start === undefined && end === undefined && isInside(folder, src)) {
        return { state: 'done', file: src.slice(folder.length + 1).split(/[\\/]+/).join('/'), note: 'already in the project folder, nothing to do' }
      }
      const duration = start !== undefined || end !== undefined ? await probe(src, AbortSignal.timeout(8000)).then((i) => i.duration, () => 0) : 0
      let job
      try {
        job = await startAdd({ src, dir, start, end: end !== undefined && duration ? Math.min(end, duration) : end, reencode: a.reencode === true, duration: duration || undefined })
      } catch (err) {
        throw new ToolError((err as Error).message)
      }
      await settle(job.done, 25_000, undefined)
      const file = `footage/${basename(job.dest)}`
      if (job.state === 'failed') throw new ToolError(`couldn't add it: ${job.error}`)
      if (job.state === 'working') {
        const pct = job.progress === null ? '' : `, ${Math.round(job.progress * 100)}% done`
        return { state: 'working', file, how: job.how, note: `still ${job.how === 'cut' ? 'cutting' : 'copying'}${pct}. call footage_add again with the same arguments to check on it` }
      }
      const how =
        job.how === 'link'
          ? 'linked in, it takes no extra space'
          : job.how === 'copy'
            ? 'copied in, it was on another drive'
            : job.how === 'cut'
              ? 'cut out of the recording'
              : 'it was added before'
      return { state: 'done', file, path: job.dest, how, note: `${how}. the original is untouched` }
    }
  }
]
