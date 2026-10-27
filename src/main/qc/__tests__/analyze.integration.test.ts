import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../analyze'
import { ffmpegPaths, run } from '../ffmpeg'

// one real run of the bundled ffmpeg on a clip made here: 6 seconds of 1080x1920 test pattern
// and a tone, with a black second at 2s and the sound off from 3s to 5.5s
let dir = ''
let clip = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trenddeck-qc-'))
  clip = join(dir, 'final.mp4')
  // prettier-ignore
  await run(ffmpegPaths().ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex', "[0:v]drawbox=enable='between(t,2,3)':color=black:t=fill[v];[1:a]volume=enable='between(t,3,5.5)':volume=0[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip
  ])
  writeFileSync(join(dir, 'final.srt'), '1\n00:00:00,000 --> 00:00:03,000\nhello and welcome back\n')
  writeFileSync(join(dir, 'final.txt'), 'Hello and welcome back.')
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('analyze', () => {
  it('finds the black second and the silence on a real file', async () => {
    const seen: number[] = []
    const report = await analyze(clip, { onProgress: (p) => seen.push(p) })
    const by = Object.fromEntries(report.checks.map((c) => [c.id, c]))
    expect(report.target).toBe('shorts')
    expect(report.guessed).toBe(true)
    expect(report.duration).toBeCloseTo(6, 0)
    expect(by.resolution.status).toBe('pass')
    expect(by.format.status).toBe('pass')
    expect(by.fps.detail).toBe('30 fps')
    expect(by.black.status).toBe('warn')
    expect(by.black.at?.[0]).toBeCloseTo(2, 0)
    expect(by.silence.status).toBe('warn')
    expect(by.silence.at?.[0]).toBeCloseTo(3, 0)
    expect(by.loudness.detail).toMatch(/LUFS/)
    expect(by.frozen.status).toBe('pass')
    expect(by.hook).toBeDefined()
    expect(by.captions.status).toBe('pass')
    expect(seen.at(-1)).toBe(1)
  })

  it('checks against the target it was given', async () => {
    const report = await analyze(clip, { target: 'youtube' })
    expect(report.guessed).toBe(false)
    expect(report.checks.find((c) => c.id === 'resolution')?.status).toBe('fail')
  })
})
