import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { QcCheck, QcOptions, QcReport, QcTarget } from '@shared/qc'
import {
  BLACK_MIN,
  checkBlack,
  checkCaptions,
  checkDuration,
  checkFormat,
  checkFps,
  checkFreezes,
  checkHook,
  checkLoudness,
  checkResolution,
  checkSilences,
  FREEZE_MIN,
  guessTarget,
  HOOK_SECONDS,
  parseBlack,
  parseFreezes,
  parseLoudness,
  parseProgressTime,
  parseSceneScores,
  parseSilences,
  SILENCE_MIN
} from './checks'
import { ffmpegPaths, probe, run } from './ffmpeg'

// runs every check on one video file. no electron here, the ipc and the folder rules are in
// ./index.ts, so the tests can call this on a file they made

// the analysis frames are made small first, the checks don't need the detail and it's much faster
const SMALL = 'scale=-2:360'

export interface AnalyzeOpts extends QcOptions {
  signal?: AbortSignal
  // 0..1
  onProgress?: (p: number) => void
}

async function readIf(path: string | null): Promise<string | null> {
  if (!path) return null
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function firstThere(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      if ((await fs.stat(p)).isFile()) return p
    } catch {
      // not there
    }
  }
  return null
}

// captions and a transcript named like the video, unless they were given
export async function findSidecars(path: string, opts: Pick<QcOptions, 'captions' | 'transcript'>): Promise<{ captions: string | null; transcript: string | null }> {
  const dir = dirname(path)
  const base = basename(path, extname(path))
  const captions = opts.captions ? join(dir, opts.captions) : await firstThere([join(dir, `${base}.srt`), join(dir, `${base}.vtt`)])
  const transcript = opts.transcript ? join(dir, opts.transcript) : await firstThere([join(dir, `${base}.txt`), join(dir, 'transcript.txt')])
  return { captions, transcript }
}

export async function analyze(path: string, opts: AnalyzeOpts = {}): Promise<QcReport> {
  const { ffmpeg } = ffmpegPaths()
  const info = await probe(path, opts.signal)
  const target: QcTarget = opts.target ?? guessTarget(info)
  const hasAudio = info.audioCodec !== ''
  const hasVideo = info.videoCodec !== ''
  const duration = info.duration
  const progress = (share: number, from: number) => (chunk: Buffer) => {
    const t = parseProgressTime(chunk.toString('utf8'))
    if (t !== null && duration > 0) opts.onProgress?.(Math.min(1, from + share * Math.min(1, t / duration)))
  }

  // one pass over the whole file: loudness and silences on the sound, black and frozen
  // stretches on the picture
  const graph: string[] = []
  const maps: string[] = []
  if (hasAudio) {
    graph.push(`[0:a:0]ebur128=peak=true:framelog=verbose,silencedetect=n=-50dB:d=${SILENCE_MIN}[a]`)
    maps.push('-map', '[a]')
  }
  if (hasVideo) {
    graph.push(`[0:v:0]${SMALL},blackdetect=d=${BLACK_MIN}:pix_th=0.10,freezedetect=n=-60dB:d=${FREEZE_MIN}[v]`)
    maps.push('-map', '[v]')
  }
  let full = ''
  if (graph.length) {
    const r = await run(
      ffmpeg,
      ['-hide_banner', '-nostats', '-loglevel', 'info', '-progress', 'pipe:1', '-i', path, '-filter_complex', graph.join(';'), ...maps, '-f', 'null', '-'],
      { signal: opts.signal, fullStderr: true, onStdout: progress(0.9, 0) }
    )
    full = r.stderr
  }

  // the opening on its own: a scene score for every frame of the first seconds
  let scores: { t: number; score: number }[] = []
  if (hasVideo) {
    const r = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'info',
        '-progress',
        'pipe:1',
        '-t',
        String(HOOK_SECONDS + 0.1),
        '-i',
        path,
        '-an',
        '-vf',
        `${SMALL},select='gte(scene,0)',metadata=print:key=lavfi.scene_score`,
        '-f',
        'null',
        '-'
      ],
      { signal: opts.signal, fullStderr: true }
    )
    scores = parseSceneScores(r.stderr)
  }
  opts.onProgress?.(0.97)

  const checks: QcCheck[] = [checkFormat(info), checkResolution(info, target), checkFps(info), checkDuration(info, target)]
  checks.push(...checkLoudness(parseLoudness(full), hasAudio))
  checks.push(checkSilences(parseSilences(full, duration), duration, hasAudio))
  if (hasVideo) {
    checks.push(checkBlack(parseBlack(full), duration))
    checks.push(checkFreezes(parseFreezes(full, duration), duration))
    checks.push(checkHook(scores))
  }

  const side = await findSidecars(path, opts)
  const [captions, transcript] = await Promise.all([readIf(side.captions), readIf(side.transcript)])
  if (captions !== null && transcript !== null && side.captions && side.transcript) {
    checks.push(checkCaptions(captions, transcript, duration, { captions: basename(side.captions), transcript: basename(side.transcript) }))
  }
  opts.onProgress?.(1)

  return { file: basename(path), target, guessed: !opts.target, duration, checks, ranAt: Date.now() }
}
