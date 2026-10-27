import { existsSync, mkdtempSync, promises as fs, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { secondsToTicks, sequenceDuration, ticksToSeconds, type MediaProbe } from '@shared/editor'
import { AbortedError, exportSequence, ffmpegPaths, makeProxy, probe, renderFrame, run, thumbnailStrip, waveformPeaks } from '../ffmpeg'
import { systemFonts } from '../fonts'
import { buildEdit } from './fixture'

// real encodes with the bundled ffmpeg. set TRENDDECK_SKIP_FFMPEG=1 to skip on machines
// without the binaries
const skip = process.env.TRENDDECK_SKIP_FFMPEG === '1'

let dir = ''
const paths = { video: '', still: '' }
let probes: { video: MediaProbe; still: MediaProbe }
const fonts = process.platform === 'win32' ? systemFonts() : undefined

describe.skipIf(skip)('ffmpeg', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'td-editor-'))
    paths.video = join(dir, 'source clip.mp4')
    paths.still = join(dir, 'logo.png')
    const { ffmpeg } = ffmpegPaths()
    await run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', paths.video])
    await run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=s=200x200:d=1', '-frames:v', '1', paths.still])
    probes = { video: await probe(paths.video), still: await probe(paths.still) }
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('probes video and stills', () => {
    expect(probes.video).toMatchObject({ hasVideo: true, hasAudio: true, isStill: false, width: 320, height: 240, fps: { num: 30, den: 1 } })
    expect(ticksToSeconds(probes.video.duration)).toBeCloseTo(4, 1)
    expect(probes.still).toMatchObject({ hasVideo: true, hasAudio: false, isStill: true, width: 200, height: 200 })
  })

  it('makes waveform peaks, thumbnails and a proxy', async () => {
    const w = await waveformPeaks(paths.video)
    expect(w.rate).toBe(100)
    expect(w.peaks.length / 2).toBeGreaterThan(390)
    expect(Math.max(...w.peaks)).toBeGreaterThan(0.1)
    const strip = await thumbnailStrip(paths.video, probes.video, { count: 5, height: 40 })
    expect(Buffer.from(strip.png.subarray(0, 4)).toString('latin1')).toBe('\x89PNG')
    expect(strip.times).toHaveLength(5)
    const proxy = join(dir, 'proxy', 'p.mp4')
    await makeProxy(paths.video, proxy, probes.video, { height: 120 })
    const pp = await probe(proxy)
    expect(pp.height).toBe(120)
  })

  it('renders a single composited frame', async () => {
    const { session, seqId } = buildEdit(paths, probes)
    const png = await renderFrame(session.project, seqId, secondsToTicks(2.1), { fonts })
    expect(png.subarray(0, 4).toString('latin1')).toBe('\x89PNG')
    await fs.writeFile(join(dir, 'frame.png'), png)
    const info = await probe(join(dir, 'frame.png'))
    expect([info.width, info.height]).toEqual([640, 360])
  })

  it('exports the whole edit with picture and sound at the preset size', async () => {
    const { session, seqId } = buildEdit(paths, probes)
    const out = join(dir, 'out', 'export.mp4')
    const seen: number[] = []
    const r = await exportSequence(session.project, seqId, 'youtube_1080p', out, (p) => seen.push(p), undefined, { fonts })
    expect(r.warnings).toEqual([])
    const info = await probe(out)
    const seq = session.project.items[seqId]
    if (seq.kind !== 'sequence') throw new Error()
    expect(info).toMatchObject({ hasVideo: true, hasAudio: true, width: 1920, height: 1080 })
    expect(ticksToSeconds(info.duration)).toBeCloseTo(ticksToSeconds(sequenceDuration(seq)), 1)
    expect(seen.at(-1)).toBe(1)
  })

  it('deletes the partial file when an export is cancelled', async () => {
    const { session, seqId } = buildEdit(paths, probes)
    const outDir = join(dir, 'cancel')
    const out = join(outDir, 'cancelled.mp4')
    const ac = new AbortController()
    const job = exportSequence(session.project, seqId, 'vertical_1080x1920', out, () => ac.abort(), ac.signal, { fonts })
    await expect(job).rejects.toBeInstanceOf(AbortedError)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([])
  })
})
