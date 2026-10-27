import { describe, expect, it } from 'vitest'
import {
  FPS,
  MAX_TICK,
  TICKS_PER_SECOND,
  framesToTicks,
  framesToTimecode,
  secondsToTicks,
  snapToFrame,
  ticksPerFrame,
  ticksPerSample,
  ticksToFrames,
  timecodeToFrames,
  toTicks,
  TimeError
} from '../time'

describe('tick rate', () => {
  it('divides every common frame rate and sample rate', () => {
    for (const fps of Object.values(FPS)) expect(Number.isInteger(ticksPerFrame(fps))).toBe(true)
    for (const r of [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000]) expect(Number.isInteger(ticksPerSample(r))).toBe(true)
    expect(ticksPerFrame({ num: 120, den: 1 })).toBe(TICKS_PER_SECOND / 120)
  })

  it('fits 9 hours in a safe integer with margin for offsets', () => {
    expect(Number.isSafeInteger(MAX_TICK + 50 * 60 * TICKS_PER_SECOND)).toBe(true)
    expect(() => secondsToTicks(10 * 3600)).toThrow(TimeError)
  })

  it('round trips frames exactly at 29.97 for a long timeline', () => {
    const f = 29.97 * 3600 * 8
    const frames = Math.floor(f)
    const t = framesToTicks(frames, FPS.f29_97)
    expect(Number.isSafeInteger(t)).toBe(true)
    expect(ticksToFrames(t, FPS.f29_97)).toBe(frames)
  })

  it('accumulates frames with no drift', () => {
    let t = 0
    for (let i = 0; i < 100_000; i++) t += ticksPerFrame(FPS.f23_976)
    expect(t).toBe(framesToTicks(100_000, FPS.f23_976))
  })

  it('snaps to frames', () => {
    const tpf = ticksPerFrame(FPS.f30)
    expect(snapToFrame(tpf * 3 + 1, FPS.f30)).toBe(tpf * 3)
    expect(snapToFrame(tpf * 3 + 1, FPS.f30, 'ceil')).toBe(tpf * 4)
  })
})

describe('timecode', () => {
  it('formats non drop frame', () => {
    expect(framesToTimecode(0, FPS.f25)).toBe('00:00:00:00')
    expect(framesToTimecode(25 * 3661 + 7, FPS.f25)).toBe('01:01:01:07')
  })

  it('formats SMPTE drop frame at 29.97', () => {
    expect(framesToTimecode(1799, FPS.f29_97)).toBe('00:00:59;29')
    expect(framesToTimecode(1800, FPS.f29_97)).toBe('00:01:00;02')
    expect(framesToTimecode(17982, FPS.f29_97)).toBe('00:10:00;00')
    expect(framesToTimecode(17981, FPS.f29_97)).toBe('00:09:59;29')
  })

  it('parses what it formats', () => {
    for (const fps of [FPS.f29_97, FPS.f59_94, FPS.f25, FPS.f24]) {
      for (const f of [0, 1, 1799, 1800, 1801, 17982, 107892, 123456]) expect(timecodeToFrames(framesToTimecode(f, fps), fps)).toBe(f)
    }
  })

  it('rejects bad timecode', () => {
    expect(() => timecodeToFrames('00:00:00:30', FPS.f30)).toThrow(TimeError)
    expect(() => timecodeToFrames('1:2', FPS.f30)).toThrow(TimeError)
  })
})

describe('toTicks', () => {
  it('reads every input form', () => {
    const fps = FPS.f30
    const one = TICKS_PER_SECOND
    expect(toTicks(1.5, fps)).toBe(1.5 * one)
    expect(toTicks('1.5s', fps)).toBe(1.5 * one)
    expect(toTicks('45f', fps)).toBe(1.5 * one)
    expect(toTicks('00:00:01:15', fps)).toBe(1.5 * one)
    expect(toTicks({ frames: 45 }, fps)).toBe(1.5 * one)
    expect(toTicks({ seconds: 1.5 }, fps)).toBe(1.5 * one)
    expect(toTicks({ timecode: '00:00:01:15' }, fps)).toBe(1.5 * one)
    expect(toTicks({ ticks: 42 }, fps)).toBe(42)
    expect(toTicks('42t', fps)).toBe(42)
  })

  it('rounds float seconds to the nearest tick once', () => {
    expect(toTicks(0.1, FPS.f30)).toBe(TICKS_PER_SECOND / 10)
    expect(Number.isSafeInteger(toTicks(1 / 3, FPS.f30))).toBe(true)
  })

  it('refuses junk', () => {
    expect(() => toTicks('soon', FPS.f30)).toThrow(TimeError)
    expect(() => toTicks({ ticks: 1.5 }, FPS.f30)).toThrow(TimeError)
    expect(() => toTicks(Number.NaN, FPS.f30)).toThrow(TimeError)
  })
})
