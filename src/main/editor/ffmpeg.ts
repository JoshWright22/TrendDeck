import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import {
  probeDefaults,
  secondsToTicks,
  sequenceDuration,
  getSequence,
  ticksPerFrame,
  ticksToSeconds,
  type MediaProbe,
  type Project,
  type Rational,
  type Tick
} from '@shared/editor'
import type { ExportPresetId, ThumbnailStrip, WaveformData } from '@shared/editor'
import { buildRenderGraph, EXPORT_PRESETS, type FontResolver, type RenderGraph } from './filtergraph'

// the ffmpeg side of the editor: probing, proxies, waveforms, thumbnails, single frames and
// full exports. binaries come from ffmpeg-static and ffprobe-static; in a packaged app they sit
// in app.asar.unpacked because a process can't be spawned from inside the asar archive

function unpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

let paths: { ffmpeg: string; ffprobe: string } | null = null

export function ffmpegPaths(): { ffmpeg: string; ffprobe: string } {
  if (paths) return paths
  const ffmpeg = process.env.TRENDDECK_FFMPEG || unpacked(ffmpegStatic ?? '')
  const ffprobe = process.env.TRENDDECK_FFPROBE || unpacked(ffprobeStatic.path)
  if (!ffmpeg || !existsSync(ffmpeg)) throw new Error('ffmpeg binary is missing')
  if (!ffprobe || !existsSync(ffprobe)) throw new Error('ffprobe binary is missing')
  paths = { ffmpeg, ffprobe }
  return paths
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message)
  }
}

export class AbortedError extends Error {
  constructor() {
    super('cancelled')
  }
}

interface RunOpts {
  signal?: AbortSignal
  // called with each stdout chunk; when given, stdout isn't collected
  onStdout?: (chunk: Buffer) => void
  onStderrLine?: (line: string) => void
}

// runs a binary and resolves with stdout. keeps the stderr tail for error messages
export function run(bin: string, args: string[], opts: RunOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AbortedError())
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let pending = ''
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => (opts.onStdout ? opts.onStdout(b) : out.push(b)))
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString('utf8')
      err = (err + s).slice(-8000)
      if (opts.onStderrLine) {
        pending += s
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const l of lines) opts.onStderrLine(l)
      }
    })
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new AbortedError())
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new FfmpegError(`${bin.split(/[\\/]/).pop()} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`, err))
    })
  })
}

function parseRate(s: string | undefined): Rational | null {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '')
  if (!m || m[2] === '0' || m[1] === '0') return null
  const r = { num: Number(m[1]), den: Number(m[2]) }
  // snap near misses like 2997/100 to the exact broadcast rate
  const v = r.num / r.den
  for (const [n, d] of [
    [24000, 1001],
    [30000, 1001],
    [60000, 1001]
  ]) {
    if (Math.abs(v - n / d) < 0.005) return { num: n, den: d }
  }
  if (Math.abs(v - Math.round(v)) < 0.005) return { num: Math.round(v), den: 1 }
  return r
}

const STILL_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
  nb_frames?: string
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
  disposition?: { attached_pic?: number }
}

export async function probe(path: string): Promise<MediaProbe> {
  const out = await run(ffmpegPaths().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  const json = JSON.parse(out.toString('utf8')) as { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } }
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const a = streams.find((s) => s.codec_type === 'audio')
  const isStill = !!v && !a && (STILL_EXT.test(path) || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(json.format?.format_name ?? '') || v.nb_frames === '1')
  const seconds = Number(json.format?.duration ?? v?.duration ?? a?.duration ?? 0)
  const rotation = (((Number(v?.tags?.rotate ?? 0) || -(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 360) + 360) % 360
  let width = v?.width ?? 0
  let height = v?.height ?? 0
  if (rotation === 90 || rotation === 270) [width, height] = [height, width]
  const fps = v && !isStill ? parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate) : null
  return probeDefaults({
    duration: isStill || !Number.isFinite(seconds) ? 0 : secondsToTicks(seconds),
    hasVideo: !!v,
    hasAudio: !!a,
    isStill,
    width,
    height,
    fps,
    sampleRate: Number(a?.sample_rate ?? 0),
    channels: a?.channels ?? 0,
    videoCodec: v?.codec_name ?? '',
    audioCodec: a?.codec_name ?? '',
    rotation
  })
}

// ffmpeg -progress lines give out_time_us; turns them into 0..1
function progressReader(totalSeconds: number, onProgress?: (p: number) => void): (chunk: Buffer) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l.trim())
      if (m && onProgress && totalSeconds > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds))
    }
  }
}

// writes to a temp name next to the target and renames at the end, so a cancelled or failed
// job never leaves a half file behind
async function withPartial<T>(outPath: string, fn: (tmp: string) => Promise<T>): Promise<T> {
  const ext = outPath.match(/\.[^./\\]+$/)?.[0] ?? ''
  const tmp = `${outPath}.partial-${process.pid}-${Date.now()}${ext}`
  try {
    const r = await fn(tmp)
    await fs.rename(tmp, outPath).catch(async () => {
      await fs.rm(outPath, { force: true })
      await fs.rename(tmp, outPath)
    })
    return r
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export interface ProxyOptions {
  height?: number
  signal?: AbortSignal
  onProgress?: (p: number) => void
}

// small H.264 with a keyframe every 12 frames, so scrubbing the timeline seeks fast
export async function makeProxy(src: string, dst: string, info: MediaProbe, opts: ProxyOptions = {}): Promise<void> {
  const h = opts.height ?? 540
  await fs.mkdir(dirname(dst), { recursive: true })
  await withPartial(dst, (tmp) =>
    run(
      ffmpegPaths().ffmpeg,
      [
        '-hide_banner', '-nostdin', '-y', '-i', src,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-vf', `scale=-2:'min(${h},ih)':flags=bilinear,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-bf', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart', '-f', 'mp4',
        '-progress', 'pipe:1', '-nostats', tmp
      ],
      { signal: opts.signal, onStdout: progressReader(ticksToSeconds(info.duration), opts.onProgress) }
    )
  )
}

// min/max pairs per bucket from 8 kHz mono, enough for a timeline waveform at any zoom
export async function waveformPeaks(path: string, opts: { peaksPerSecond?: number; signal?: AbortSignal } = {}): Promise<WaveformData> {
  const rate = opts.peaksPerSecond ?? 100
  const sampleRate = 8000
  const per = Math.max(1, Math.round(sampleRate / rate))
  const peaks: number[] = []
  let min = 1
  let max = -1
  let n = 0
  let carry: Buffer | null = null
  await run(ffmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', '-i', path, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'], {
    signal: opts.signal,
    onStdout: (chunk) => {
      let b = carry ? Buffer.concat([carry, chunk]) : chunk
      const even = b.length - (b.length % 2)
      carry = even < b.length ? b.subarray(even) : null
      b = b.subarray(0, even)
      for (let i = 0; i < b.length; i += 2) {
        const v = b.readInt16LE(i) / 32768
        if (v < min) min = v
        if (v > max) max = v
        if (++n === per) {
          peaks.push(min, max)
          min = 1
          max = -1
          n = 0
        }
      }
    }
  })
  if (n > 0) peaks.push(min, max)
  return { rate: sampleRate / per, peaks: Float32Array.from(peaks) }
}

// one PNG sprite of evenly spaced frames, left to right
export async function thumbnailStrip(path: string, info: MediaProbe, opts: { count: number; height?: number; signal?: AbortSignal }): Promise<ThumbnailStrip> {
  const count = Math.max(1, Math.min(200, Math.floor(opts.count)))
  const h = opts.height ?? 72
  const w = Math.max(2, Math.round((h * (info.width || 16)) / (info.height || 9) / 2) * 2)
  const dur = info.isStill ? 0 : ticksToSeconds(info.duration)
  const times: Tick[] = Array.from({ length: count }, (_, i) => (info.isStill ? 0 : secondsToTicks(((i + 0.5) * dur) / count)))
  const vf = info.isStill
    ? `scale=${w}:${h},loop=loop=${count - 1}:size=1,tile=${count}x1`
    : `fps=${count}/${Math.max(dur, 0.001).toFixed(6)},scale=${w}:${h},tile=${count}x1`
  const png = await run(
    ffmpegPaths().ffmpeg,
    ['-hide_banner', '-nostdin', '-i', path, '-an', '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
    { signal: opts.signal }
  )
  return { png: new Uint8Array(png), tileWidth: w, tileHeight: h, times }
}

export interface RenderEnv {
  // where caption and text files for the graph go, made fresh per job
  tempDir?: string
  fonts?: FontResolver
  // proxies for speed, originals for quality
  useProxies?: boolean
}

async function runGraph(graph: RenderGraph, tempDir: string, outArgs: string[], opts: RunOpts): Promise<Buffer> {
  await fs.mkdir(tempDir, { recursive: true })
  for (const f of graph.files) await fs.writeFile(join(tempDir, f.name), f.content, 'utf8')
  const script = join(tempDir, 'graph.txt')
  await fs.writeFile(script, graph.filter, 'utf8')
  try {
    return await run(ffmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', '-y', ...graph.inputArgs, '-filter_complex_script', script, ...graph.maps, ...outArgs], opts)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function jobDir(env: RenderEnv): string {
  return env.tempDir ?? join(tmpdir(), `trenddeck-render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

// the composited picture of one sequence frame, as PNG bytes
export async function renderFrame(
  project: Project,
  sequenceId: string,
  tick: Tick,
  env: RenderEnv & { maxWidth?: number; signal?: AbortSignal } = {}
): Promise<Buffer> {
  const seq = getSequence(project, sequenceId)
  const frame = ticksPerFrame(seq.fps)
  const at = Math.max(0, Math.floor(tick / frame) * frame)
  const dir = jobDir(env)
  const graph = buildRenderGraph(project, sequenceId, {
    from: at,
    to: at + frame,
    tempDir: dir,
    audio: false,
    fonts: env.fonts,
    useProxies: env.useProxies ?? true,
    output: env.maxWidth && env.maxWidth < seq.width ? { width: env.maxWidth - (env.maxWidth % 2), height: Math.round((seq.height * env.maxWidth) / seq.width / 2) * 2, fit: 'fit' } : undefined
  })
  return runGraph(graph, dir, ['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { signal: env.signal })
}

export interface ExportResult {
  outputPath: string
  warnings: string[]
}

export async function exportSequence(
  project: Project,
  sequenceId: string,
  presetId: ExportPresetId,
  outputPath: string,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
  env: RenderEnv & { range?: { from: Tick; to: Tick } } = {}
): Promise<ExportResult> {
  const seq = getSequence(project, sequenceId)
  const preset = EXPORT_PRESETS[presetId]
  if (!preset) throw new Error(`unknown export preset ${presetId}`)
  const from = env.range?.from ?? 0
  const to = env.range?.to ?? sequenceDuration(seq)
  if (to <= from) throw new Error('nothing to export, the sequence is empty')
  const dir = jobDir(env)
  const graph = buildRenderGraph(project, sequenceId, {
    from,
    to,
    tempDir: dir,
    audio: true,
    fonts: env.fonts,
    useProxies: env.useProxies ?? false,
    output: { width: preset.width, height: preset.height, fit: preset.fit }
  })
  await fs.mkdir(dirname(outputPath), { recursive: true })
  await withPartial(outputPath, (tmp) =>
    runGraph(
      graph,
      dir,
      [
        '-c:v', 'libx264', '-preset', preset.x264Preset, '-crf', String(preset.crf), '-maxrate', preset.maxrate, '-bufsize', preset.bufsize,
        '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', `${seq.fps.num}/${seq.fps.den}`,
        '-c:a', 'aac', '-b:a', preset.audioBitrate, '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', '-t', ticksToSeconds(to - from).toFixed(6), '-f', 'mp4',
        '-progress', 'pipe:1', '-nostats', tmp
      ],
      { signal, onStdout: progressReader(ticksToSeconds(to - from), onProgress) }
    )
  )
  onProgress?.(1)
  return { outputPath, warnings: graph.warnings }
}
