import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ffmpegPaths, run } from '../qc/ffmpeg'
import { safeName, uniqueName } from '../craft/rules'
import { clock } from './frames'
import { mediaKind } from './search'

// putting a recording into a project's footage folder. a whole file on the same drive is a hard
// link: instant, no extra space, and the original stays where it is. otherwise a copy, or for a
// part of a long recording an ffmpeg cut. the original is only ever read

export interface PlaceOps {
  stat: (p: string) => Promise<{ dev: number; size: number }>
  link: (from: string, to: string) => Promise<void>
  copy: (from: string, to: string, onBytes: (n: number) => void) => Promise<void>
}

async function streamCopy(from: string, to: string, onBytes: (n: number) => void): Promise<void> {
  let done = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      onBytes(done)
      cb(null, chunk)
    }
  })
  await pipeline(createReadStream(from, { highWaterMark: 4 * 1024 * 1024 }), count, createWriteStream(to, { flags: 'wx' }))
}

export const realOps: PlaceOps = {
  stat: (p) => fs.stat(p),
  link: (from, to) => fs.link(from, to),
  copy: streamCopy
}

// the whole file: a link when both are on one volume and links work there, a copy otherwise
export async function placeWhole(src: string, dest: string, destDir: string, onBytes: (n: number) => void, ops: PlaceOps = realOps): Promise<'link' | 'copy'> {
  const [a, b] = await Promise.all([ops.stat(src), ops.stat(destDir)])
  if (a.dev === b.dev) {
    try {
      await ops.link(src, dest)
      return 'link'
    } catch {
      // FAT and exFAT drives and some network shares have no hard links
    }
  }
  await ops.copy(src, dest, onBytes)
  return 'copy'
}

// the ffmpeg args for a part of a recording. stream copy starts at the keyframe at or before
// start, so it can begin a second or two early; a re-encode is exact
export function cutArgs(src: string, dest: string, start: number, end: number, reencode: boolean): string[] {
  const head = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-n', '-ss', String(start), '-i', src, '-t', String(Math.round((end - start) * 1000) / 1000)]
  if (reencode) {
    // prettier-ignore
    return [...head, '-map', '0:v:0?', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dest]
  }
  // every video and audio track, so OBS's separate game and mic tracks stay separate
  return [...head, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', dest]
}

// "2026-10-20 14-33-11 0.12.30-0.20.00.mkv" for a cut, the file's own name otherwise
export function footageName(src: string, cut: { start: number; end: number } | null, reencode: boolean): string {
  const ext = reencode ? '.mp4' : extname(src).toLowerCase()
  const stem = safeName(basename(src, extname(src)), 'footage')
  if (!cut) return `${stem}${ext}`
  const t = (s: number): string => clock(s).replace(/:/g, '.')
  return `${stem} ${t(cut.start)}-${t(cut.end)}${ext}`
}

export function parseProgress(text: string): number | null {
  const all = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)]
  const last = all.at(-1)
  return last ? Number(last[1]) / 1_000_000 : null
}

export interface AddJob {
  key: string
  dest: string
  how: 'link' | 'copy' | 'cut' | 'already there'
  state: 'working' | 'done' | 'failed'
  progress: number | null
  error: string
  startedAt: number
  done: Promise<void>
}

const jobs = new Map<string, AddJob>()
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

export interface AddRequest {
  src: string
  // the project's footage folder
  dir: string
  start?: number
  end?: number
  reencode?: boolean
  duration?: number
}

const jobKey = (r: AddRequest): string => [r.dir, r.src, r.start ?? '', r.end ?? '', r.reencode ? 1 : 0].join('|').toLowerCase()

export function findJob(r: AddRequest): AddJob | undefined {
  return jobs.get(jobKey(r))
}

// moves a finished file from staging into the folder under a name nothing has, never over a file
// that's there. a link then unlink can't overwrite, a rename on windows can
export async function moveIn(temp: string, dir: string, want: string): Promise<string> {
  const ext = extname(want)
  const stem = want.slice(0, want.length - ext.length)
  const taken = new Set((await fs.readdir(dir).catch(() => [] as string[])).map((t) => t.slice(0, t.length - extname(t).length)))
  for (;;) {
    const dest = join(dir, `${uniqueName(stem, taken)}${ext}`)
    try {
      await fs.link(temp, dest)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        taken.add(basename(dest, ext))
        continue
      }
      // no hard links on this drive
      if (await exists(dest)) {
        taken.add(basename(dest, ext))
        continue
      }
      await fs.rename(temp, dest)
      return dest
    }
    await fs.unlink(temp)
    return dest
  }
}

// starts putting the file in, or hands back the one already going for the same request. the
// result lands under .adding first and is moved in when finished, so editors never see half a file
export async function startAdd(r: AddRequest): Promise<AddJob> {
  const key = jobKey(r)
  const running = jobs.get(key)
  // a finished one counts while its file is still there
  if (running && (running.state === 'working' || (running.state === 'done' && (await exists(running.dest))))) return running
  if (!mediaKind(r.src)) throw new Error('that is not a video or audio file')
  const st = await fs.stat(r.src).catch(() => null)
  if (!st?.isFile()) throw new Error("there's no file at that path")
  const cut = r.start !== undefined || r.end !== undefined ? { start: r.start ?? 0, end: r.end ?? r.duration ?? 0 } : null
  if (!cut) {
    // added before, by an earlier session: same name and size
    const same = join(r.dir, footageName(r.src, null, false))
    const there = await fs.stat(same).catch(() => null)
    if (there?.isFile() && there.size === st.size) {
      const job: AddJob = { key, dest: same, how: 'already there', state: 'done', progress: 1, error: '', startedAt: Date.now(), done: Promise.resolve() }
      jobs.set(key, job)
      return job
    }
  }
  if (cut) {
    if (!(cut.start >= 0)) throw new Error("start can't be before the beginning")
    if (!(cut.end > cut.start)) throw new Error('end has to be after start')
    if (r.duration && cut.start >= r.duration) throw new Error(`start is past the end, the recording is ${clock(r.duration)} long`)
  }
  await fs.mkdir(r.dir, { recursive: true })
  const staging = join(r.dir, '.adding')
  await fs.mkdir(staging, { recursive: true })
  const want = footageName(r.src, cut, !!r.reencode)
  const temp = join(staging, `${Date.now().toString(36)}-${want}`)
  // the name it will most likely get, settled when it's moved in
  const job: AddJob = { key, dest: join(r.dir, want), how: cut ? 'cut' : 'link', state: 'working', progress: 0, error: '', startedAt: Date.now(), done: Promise.resolve() }
  jobs.set(key, job)
  const work = async (): Promise<void> => {
    if (cut) {
      const span = cut.end - cut.start
      await run(ffmpegPaths().ffmpeg, cutArgs(r.src, temp, cut.start, cut.end, !!r.reencode), {
        onStdout: (b) => {
          const t = parseProgress(b.toString('utf8'))
          if (t !== null && span > 0) job.progress = Math.min(0.99, t / span)
        }
      })
    } else {
      job.how = await placeWhole(r.src, temp, staging, (n) => {
        job.progress = st.size ? Math.min(0.99, n / st.size) : null
      })
    }
    job.dest = await moveIn(temp, r.dir, want)
  }
  job.done = work().then(
    () => {
      job.state = 'done'
      job.progress = 1
    },
    async (err: Error) => {
      job.state = 'failed'
      job.error = err.message
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  )
  void job.done.finally(() => fs.rmdir(staging).catch(() => {}))
  return job
}
