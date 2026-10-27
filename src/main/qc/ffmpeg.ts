import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { VideoInfo } from './checks'

// the bundled ffmpeg and ffprobe. in a packaged app they sit in app.asar.unpacked because a
// process can't be spawned from inside the asar archive

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

interface RunOpts {
  signal?: AbortSignal
  onStdout?: (chunk: Buffer) => void
  // keep the whole stderr, the checks read their results from it
  fullStderr?: boolean
}

// runs a binary and resolves with stdout and stderr
export function run(bin: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('cancelled'))
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => (opts.onStdout ? opts.onStdout(b) : out.push(b)))
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8')
      if (!opts.fullStderr && err.length > 16_000) err = err.slice(-8000)
    })
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err })
      else reject(new FfmpegError(`${bin.split(/[\\/]/).pop()} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`, err))
    })
  })
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  pix_fmt?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
  disposition?: { attached_pic?: number }
}

function rate(s: string | undefined): number {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '')
  if (!m || m[2] === '0') return 0
  return Number(m[1]) / Number(m[2])
}

// ffprobe's json, as the checks want it
export function parseProbe(json: string): VideoInfo {
  const j = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } }
  const streams = j.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const a = streams.find((s) => s.codec_type === 'audio')
  const rotation = (((Number(v?.tags?.rotate ?? 0) || -(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 360) + 360) % 360
  let width = v?.width ?? 0
  let height = v?.height ?? 0
  if (rotation === 90 || rotation === 270) [width, height] = [height, width]
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0)
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate),
    videoCodec: v?.codec_name ?? '',
    pixFmt: v?.pix_fmt ?? '',
    audioCodec: a?.codec_name ?? '',
    container: j.format?.format_name ?? ''
  }
}

export async function probe(path: string, signal?: AbortSignal): Promise<VideoInfo> {
  const { stdout } = await run(ffmpegPaths().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { signal })
  return parseProbe(stdout.toString('utf8'))
}
