import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPaths, probe, run } from '../qc/ffmpeg'
import { cutArgs, footageName, moveIn, parseProgress, placeWhole, startAdd, type PlaceOps } from './add'
import { clock, contactSheet, frameArgs, frameTimes, gridColumns, parseVolume } from './frames'

describe('frame times', () => {
  it('spreads count frames over the middle of even slices', () => {
    expect(frameTimes(120, { count: 4 }).times).toEqual([15, 45, 75, 105])
    expect(frameTimes(100, { count: 2, start: 20, end: 60 }).times).toEqual([30, 50])
    expect(frameTimes(100, {}).times).toHaveLength(12)
  })

  it('caps the count and keeps inside the recording', () => {
    expect(frameTimes(1000, { count: 99 }).times).toHaveLength(36)
    const p = frameTimes(50, { count: 5, start: 40, end: 500 })
    expect(p.times).toEqual([41, 43, 45, 47, 49])
    expect(frameTimes(50, { start: 60 }).times).toEqual([])
  })

  it('steps every few seconds and says where to carry on', () => {
    expect(frameTimes(100, { every: 30 })).toEqual({ times: [0, 30, 60, 90], more: null, spacing: 30 })
    const long = frameTimes(97_200, { every: 60, start: 3600 })
    expect(long.times).toHaveLength(36)
    expect(long.times[0]).toBe(3600)
    expect(long.times[35]).toBe(3600 + 35 * 60)
    expect(long.more).toBe(3600 + 36 * 60)
  })

  it('writes times and picks a grid', () => {
    expect(clock(5)).toBe('0:05')
    expect(clock(3725.5)).toBe('1:02:05')
    expect(clock(97_199)).toBe('26:59:59')
    expect([1, 4, 6, 12, 20, 36].map(gridColumns)).toEqual([1, 4, 3, 4, 5, 6])
  })

  it('seeks before opening the file for each frame', () => {
    const a = frameArgs('C:\\rec\\long.mkv', 3600, 320, 180, 'out.png')
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a[a.indexOf('-ss') + 1]).toBe('3600')
    expect(a).toContain('-frames:v')
    expect(a.join(' ')).toContain("text='1\\:00\\:00'")
  })

  it('reads volumedetect', () => {
    expect(parseVolume('[Parsed_volumedetect_0 @ 0] mean_volume: -23.4 dB\n[Parsed_volumedetect_0 @ 0] max_volume: -3.0 dB')).toEqual({ mean: -23.4, max: -3 })
    expect(parseVolume('mean_volume: -inf dB\nmax_volume: -inf dB')).toEqual({ mean: -91, max: -91 })
    expect(parseVolume('nothing')).toBeNull()
  })
})

describe('adding footage', () => {
  const ops = (dev: [number, number], linkFails = false): PlaceOps & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      stat: vi.fn(async (p: string) => ({ dev: p === 'src' ? dev[0] : dev[1], size: 10 })),
      link: vi.fn(async () => {
        calls.push('link')
        if (linkFails) throw new Error('EPERM')
      }),
      copy: vi.fn(async (_a: string, _b: string, onBytes: (n: number) => void) => {
        calls.push('copy')
        onBytes(10)
      })
    }
  }

  it('links on the same volume', async () => {
    const o = ops([7, 7])
    expect(await placeWhole('src', 'dest', 'dir', () => {}, o)).toBe('link')
    expect(o.calls).toEqual(['link'])
  })

  it('copies across volumes, with progress', async () => {
    const o = ops([7, 8])
    const seen: number[] = []
    expect(await placeWhole('src', 'dest', 'dir', (n) => seen.push(n), o)).toBe('copy')
    expect(o.calls).toEqual(['copy'])
    expect(seen).toEqual([10])
  })

  it('copies when the drive has no hard links', async () => {
    const o = ops([7, 7], true)
    expect(await placeWhole('src', 'dest', 'dir', () => {}, o)).toBe('copy')
    expect(o.calls).toEqual(['link', 'copy'])
  })

  it('cuts with a seek before the input and a length, copying every track', () => {
    const a = cutArgs('C:\\rec\\long.mkv', 'C:\\p\\footage\\part.mkv', 3600, 4200.5, false)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a[a.indexOf('-ss') + 1]).toBe('3600')
    expect(a[a.indexOf('-t') + 1]).toBe('600.5')
    expect(a.join(' ')).toContain('-map 0:v? -map 0:a? -c copy')
    // never overwrites
    expect(a).toContain('-n')
    expect(a.at(-1)).toBe('C:\\p\\footage\\part.mkv')
    const r = cutArgs('in.mkv', 'out.mp4', 0, 10, true)
    expect(r).toContain('libx264')
    expect(r).not.toContain('copy')
  })

  it('names cuts by their times and reads ffmpeg progress', () => {
    expect(footageName('C:\\rec\\2026-10-20 14-33-11.mkv', null, false)).toBe('2026-10-20 14-33-11.mkv')
    expect(footageName('C:\\rec\\2026-10-20 14-33-11.mkv', { start: 3600, end: 4200 }, false)).toBe('2026-10-20 14-33-11 1.00.00-1.10.00.mkv')
    expect(footageName('C:\\rec\\a.MKV', { start: 0, end: 5 }, true)).toBe('a 0.00-0.05.mp4')
    expect(parseProgress('frame=1\nout_time_us=1500000\nout_time_ms=2500000\nprogress=continue\n')).toBe(2.5)
    expect(parseProgress('progress=continue')).toBeNull()
  })
})

// one real run of the bundled ffmpeg on a recording made here: 90 s of test pattern and a tone
// that goes quiet for the last 30 s
describe('on a real file', () => {
  let dir = ''
  let rec = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trenddeck-footage-'))
    rec = join(dir, 'source', '2026-10-20 14-33-11.mkv')
    await import('node:fs/promises').then((f) => f.mkdir(join(dir, 'source')))
    // prettier-ignore
    await run(ffmpegPaths().ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=90',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90',
      '-af', "volume=enable='gte(t,60)':volume=0",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', rec
    ])
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('makes a contact sheet with times and loudness', async () => {
    const sheet = await contactSheet(rec, { count: 6 })
    expect(sheet.png.subarray(1, 4).toString()).toBe('PNG')
    expect(sheet.columns).toBe(3)
    expect(sheet.rows).toBe(2)
    expect(sheet.frames.map((f) => f.at)).toEqual(['0:07', '0:22', '0:37', '0:52', '1:07', '1:22'])
    expect(sheet.frames.every((f) => f.picture)).toBe(true)
    expect(sheet.frames[0].meanDb!).toBeGreaterThan(-30)
    expect(sheet.frames[5].meanDb!).toBeLessThan(-60)
  })

  it('links the whole file in and cuts a part, leaving the original alone', async () => {
    const before = statSync(rec)
    const footage = join(dir, 'project', 'footage')
    const whole = await startAdd({ src: rec, dir: footage })
    await whole.done
    expect(whole.state).toBe('done')
    expect(whole.how).toBe('link')
    expect(statSync(whole.dest).size).toBe(before.size)
    // asking again finds the one already there
    expect((await startAdd({ src: rec, dir: footage })).dest).toBe(whole.dest)

    const part = await startAdd({ src: rec, dir: footage, start: 10, end: 30, duration: 90 })
    await part.done
    expect(part.state).toBe('done')
    expect(part.dest.endsWith('2026-10-20 14-33-11 0.10-0.30.mkv')).toBe(true)
    const info = await probe(part.dest)
    expect(info.duration).toBeGreaterThan(18)
    expect(info.duration).toBeLessThan(23)
    // the staging folder is gone, only the two files are left
    expect(readdirSync(footage).sort()).toEqual(['2026-10-20 14-33-11 0.10-0.30.mkv', '2026-10-20 14-33-11.mkv'])
    expect(existsSync(rec)).toBe(true)
    expect(statSync(rec).mtimeMs).toBe(before.mtimeMs)
  })

  it('never moves a finished file over one that is there', async () => {
    const d = join(dir, 'move')
    mkdirSync(join(d, '.adding'), { recursive: true })
    writeFileSync(join(d, 'clip.mkv'), 'theirs')
    writeFileSync(join(d, '.adding', 'new.mkv'), 'ours')
    const dest = await moveIn(join(d, '.adding', 'new.mkv'), d, 'clip.mkv')
    expect(dest).toBe(join(d, 'clip (2).mkv'))
    expect(readFileSync(join(d, 'clip.mkv'), 'utf8')).toBe('theirs')
    expect(readFileSync(dest, 'utf8')).toBe('ours')
    expect(readdirSync(join(d, '.adding'))).toEqual([])
  })
})
