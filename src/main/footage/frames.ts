import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegPaths, probe, run } from '../qc/ffmpeg'

// a contact sheet of a recording: a few frames spread over it, tiled into one picture with the
// time on each, and how loud the sound is around each frame. every frame is its own seek
// (-ss before -i), so a 27 hour recording costs the same as a short one

export const MAX_FRAMES = 36

export interface FramePlan {
  times: number[]
  // more frames were asked for than fit, the next start to carry on from
  more: number | null
  // the gap between frames, the loudness window
  spacing: number
}

// count frames spread evenly over start..end, each in the middle of its slice, or one every
// `every` seconds from start. never past the end
export function frameTimes(duration: number, o: { count?: number; every?: number; start?: number; end?: number }): FramePlan {
  const end = Math.min(o.end ?? duration, duration)
  const start = Math.max(0, Math.min(o.start ?? 0, end))
  const span = end - start
  if (!(span > 0)) return { times: [], more: null, spacing: 0 }
  if (o.every && o.every > 0) {
    const times: number[] = []
    for (let t = start; t < end && times.length < MAX_FRAMES; t += o.every) times.push(round(t))
    const next = start + times.length * o.every
    return { times, more: next < end ? round(next) : null, spacing: o.every }
  }
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(o.count ?? 12)))
  const step = span / n
  return { times: Array.from({ length: n }, (_, i) => round(start + (i + 0.5) * step)), more: null, spacing: step }
}

const round = (t: number): number => Math.round(t * 100) / 100

// 3725.5 -> 1:02:05
export function clock(t: number): string {
  const s = Math.floor(t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

// columns for n tiles, wide rather than tall since most tiles are 16:9
export function gridColumns(n: number): number {
  return n <= 4 ? n : n <= 6 ? 3 : n <= 12 ? 4 : n <= 20 ? 5 : 6
}

// a font file for the times when windows has one, fontconfig's default otherwise
function fontArg(): string {
  const f = join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf')
  return existsSync(f) ? `fontfile='${f.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : ''
}

function label(text: string, size: number): string {
  return `drawtext=${fontArg()}text='${text.replace(/[\\':]/g, (c) => `\\${c}`)}':fontcolor=white:fontsize=${size}:box=1:boxcolor=black@0.65:boxborderw=4:x=6:y=h-th-6`
}

// the one-frame grab, its args for a test to read
export function frameArgs(file: string, t: number, w: number, h: number, out: string): string[] {
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,${label(clock(t), Math.max(12, Math.round(h / 9)))}`
  // prettier-ignore
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', vf, out]
}

// mean and peak volume of the first audio track over a window from t
export function loudnessArgs(file: string, t: number, seconds: number): string[] {
  // prettier-ignore
  return ['-hide_banner', '-nostats', '-ss', String(t), '-t', String(seconds), '-i', file, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-']
}

export function parseVolume(stderr: string): { mean: number; max: number } | null {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  if (!mean || !max) return null
  const n = (s: string): number => (s === '-inf' ? -91 : Number(s))
  return { mean: n(mean[1]), max: n(max[1]) }
}

export interface SheetFrame {
  t: number
  at: string
  // false when the picture couldn't be read there, the tile is black
  picture: boolean
  // dB, 0 is the loudest. null when there's no sound track or it couldn't be read
  meanDb: number | null
  maxDb: number | null
}

export interface Sheet {
  png: Buffer
  duration: number
  width: number
  height: number
  columns: number
  rows: number
  frames: SheetFrame[]
  more: number | null
  loudnessWindow: number | null
}

async function limit<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i], i)
      }
    })
  )
}

export async function contactSheet(
  file: string,
  o: { count?: number; every?: number; start?: number; end?: number; width?: number; loudness?: boolean }
): Promise<Sheet> {
  const info = await probe(file, AbortSignal.timeout(10_000))
  // a recording OBS is still writing may not say how long it is yet, the end given counts then
  const duration = info.duration || o.end || 0
  if (!duration) throw new Error("couldn't tell how long this recording is. give an end time in seconds")
  if (o.start !== undefined && o.start >= duration) throw new Error(`start is past the end, the recording is ${clock(duration)} long (${Math.round(duration)} s)`)
  const plan = frameTimes(duration, o)
  if (!plan.times.length) throw new Error('nothing between start and end')
  const w = Math.round((o.width ?? 320) / 2) * 2
  const aspect = info.width && info.height ? info.height / info.width : 9 / 16
  const h = Math.max(2, Math.round((w * aspect) / 2) * 2)
  const { ffmpeg } = ffmpegPaths()
  const dir = await fs.mkdtemp(join(tmpdir(), 'trenddeck-sheet-'))
  try {
    const frames: SheetFrame[] = plan.times.map((t) => ({ t, at: clock(t), picture: false, meanDb: null, maxDb: null }))
    const tile = (i: number): string => join(dir, `f${String(i).padStart(2, '0')}.png`)
    const hasAudio = !!info.audioCodec && o.loudness !== false
    // around each frame, no longer than 20 s so a sparse sheet stays quick
    const window = hasAudio ? Math.max(2, Math.min(20, plan.spacing)) : null
    await limit(plan.times, 4, async (t, i) => {
      try {
        await run(ffmpeg, frameArgs(file, t, w, h, tile(i)), { signal: AbortSignal.timeout(20_000) })
        frames[i].picture = existsSync(tile(i))
      } catch {
        frames[i].picture = false
      }
      if (!frames[i].picture) {
        // prettier-ignore
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}`, '-frames:v', '1', '-vf', label(`${clock(t)} no picture`, Math.max(12, Math.round(h / 9))), tile(i)])
      }
      if (window) {
        try {
          const { stderr } = await run(ffmpeg, loudnessArgs(file, Math.max(0, t - window / 2), window), { signal: AbortSignal.timeout(20_000) })
          const v = parseVolume(stderr)
          if (v) {
            frames[i].meanDb = v.mean
            frames[i].maxDb = v.max
          }
        } catch {
          // left null
        }
      }
    })
    const columns = gridColumns(frames.length)
    const rows = Math.ceil(frames.length / columns)
    const out = join(dir, 'sheet.png')
    // prettier-ignore
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', join(dir, 'f%02d.png'),
      '-vf', `tile=${columns}x${rows}:padding=4:margin=4:color=0x18181b`, '-frames:v', '1', out
    ], { signal: AbortSignal.timeout(20_000) })
    return {
      png: await fs.readFile(out),
      duration,
      width: info.width,
      height: info.height,
      columns,
      rows,
      frames,
      more: plan.more,
      loudnessWindow: window
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
