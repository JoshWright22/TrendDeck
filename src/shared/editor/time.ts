// exact edit time. every position and length in the editor is an integer Tick
//
// 254_016_000_000 ticks a second is divisible by every common frame rate (23.976, 24, 25, 29.97,
// 30, 50, 59.94, 60, 120 and the 1001 variants) and sample rate (8k, 11.025k, 16k, 22.05k,
// 32k, 44.1k, 48k, 88.2k, 96k, 192k), so frame and sample boundaries are whole ticks and
// adding, splitting or trimming never drifts
//
// ticks are plain javascript numbers kept as safe integers, not bigint. numbers survive JSON,
// structured clone over IPC and Math.* untouched, and they're much faster in hot timeline
// loops. the cost is a ceiling: 2^53 ticks is about 9 h 51 min. MAX_TICK is 9 hours, so a
// position plus the odd offset (a transition handle, a preview window) still lands exact, and
// every conversion here throws past it

export type Tick = number

export const TICKS_PER_SECOND = 254_016_000_000
// 9 hours, about 51 minutes under 2^53
export const MAX_TICK = 9 * 3600 * TICKS_PER_SECOND

export interface Rational {
  num: number
  den: number
}

export const FPS = {
  f23_976: { num: 24000, den: 1001 },
  f24: { num: 24, den: 1 },
  f25: { num: 25, den: 1 },
  f29_97: { num: 30000, den: 1001 },
  f30: { num: 30, den: 1 },
  f50: { num: 50, den: 1 },
  f59_94: { num: 60000, den: 1001 },
  f60: { num: 60, den: 1 }
} as const satisfies Record<string, Rational>

export class TimeError extends Error {}

export function assertTick(t: number, what = 'time'): Tick {
  if (!Number.isSafeInteger(t)) throw new TimeError(`${what} must be a whole number of ticks, got ${t}`)
  if (Math.abs(t) > MAX_TICK) throw new TimeError(`${what} is past the 9 hour limit`)
  return t
}

export function isTick(t: unknown): t is Tick {
  return typeof t === 'number' && Number.isSafeInteger(t) && Math.abs(t) <= MAX_TICK
}

export function fpsValue(fps: Rational): number {
  return fps.num / fps.den
}

export function ticksPerFrame(fps: Rational): Tick {
  const t = (TICKS_PER_SECOND * fps.den) / fps.num
  if (!Number.isInteger(t)) throw new TimeError(`frame rate ${fps.num}/${fps.den} doesn't divide the tick rate`)
  return t
}

export function ticksPerSample(rate: number): Tick {
  const t = TICKS_PER_SECOND / rate
  if (!Number.isInteger(t)) throw new TimeError(`sample rate ${rate} doesn't divide the tick rate`)
  return t
}

export function isSupportedFps(fps: Rational): boolean {
  if (!(fps.num > 0 && fps.den > 0 && Number.isInteger(fps.num) && Number.isInteger(fps.den))) return false
  return Number.isInteger((TICKS_PER_SECOND * fps.den) / fps.num)
}

// the only place float seconds turn into ticks, rounded to the nearest tick (about 4 ps)
export function secondsToTicks(s: number): Tick {
  if (!Number.isFinite(s)) throw new TimeError(`seconds must be a finite number, got ${s}`)
  return assertTick(Math.round(s * TICKS_PER_SECOND), 'time')
}

// for display and for ffmpeg arguments only, never feed this back into edit math
export function ticksToSeconds(t: Tick): number {
  return t / TICKS_PER_SECOND
}

export function framesToTicks(frames: number, fps: Rational): Tick {
  if (!Number.isInteger(frames)) throw new TimeError(`frame must be a whole number, got ${frames}`)
  return assertTick(frames * ticksPerFrame(fps), 'time')
}

// the frame that contains t, so a time a hair before a boundary still lands on the earlier frame
export function ticksToFrames(t: Tick, fps: Rational): number {
  return Math.floor(t / ticksPerFrame(fps))
}

export function snapToFrame(t: Tick, fps: Rational, mode: 'floor' | 'round' | 'ceil' = 'round'): Tick {
  const f = ticksPerFrame(fps)
  return Math[mode](t / f) * f
}

// drop frame is only defined for the 1001 rates that are multiples of 30000
function dropInfo(fps: Rational): { nominal: number; drop: number } | null {
  if (fps.den !== 1001 || fps.num % 30000 !== 0) return null
  const nominal = fps.num / 1000
  return { nominal, drop: (nominal / 30) * 2 }
}

function nominalRate(fps: Rational): number {
  return Math.round(fps.num / fps.den)
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

// HH:MM:SS:FF, or HH:MM:SS;FF when drop frame
export function framesToTimecode(frames: number, fps: Rational, dropFrame = dropInfo(fps) !== null): string {
  const neg = frames < 0
  let f = Math.abs(frames)
  const info = dropFrame ? dropInfo(fps) : null
  const rate = info ? info.nominal : nominalRate(fps)
  if (info) {
    // SMPTE drop frame: skip frame numbers 0 and 1 (or 0-3 at 59.94) every minute but each tenth
    const perTenMin = rate * 600 - info.drop * 9
    const perMin = rate * 60 - info.drop
    const tens = Math.floor(f / perTenMin)
    const rem = f % perTenMin
    f += info.drop * 9 * tens
    if (rem > info.drop) f += info.drop * Math.floor((rem - info.drop) / perMin)
  }
  const ff = f % rate
  const totalS = Math.floor(f / rate)
  const sep = info ? ';' : ':'
  const tc = `${pad(Math.floor(totalS / 3600))}:${pad(Math.floor(totalS / 60) % 60)}:${pad(totalS % 60)}${sep}${pad(ff)}`
  return neg ? `-${tc}` : tc
}

export function timecodeToFrames(tc: string, fps: Rational): number {
  const m = /^(-)?(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{2,3})$/.exec(tc.trim())
  if (!m) throw new TimeError(`timecode must look like HH:MM:SS:FF, got "${tc}"`)
  const [, neg, hh, mm, ss, sep, ffs] = m
  const h = Number(hh)
  const min = Number(mm)
  const s = Number(ss)
  const ff = Number(ffs)
  const info = sep === ';' || (sep === '.' && dropInfo(fps)) ? dropInfo(fps) : null
  const rate = info ? info.nominal : nominalRate(fps)
  if (min > 59 || s > 59 || ff >= rate) throw new TimeError(`timecode "${tc}" is out of range for ${rate} fps`)
  let frames = ((h * 60 + min) * 60 + s) * rate + ff
  if (info) {
    const totalMin = h * 60 + min
    frames -= info.drop * (totalMin - Math.floor(totalMin / 10))
  }
  return neg ? -frames : frames
}

export function ticksToTimecode(t: Tick, fps: Rational): string {
  return framesToTimecode(ticksToFrames(t, fps), fps)
}

// what a command or tool may pass anywhere a time is expected. converted once, at the edge
//   1.5                 seconds
//   "1.5s" "90f" "1000t" seconds, frames, ticks
//   "00:00:01:15"       timecode in the sequence frame rate (";" for drop frame)
//   { seconds } { frames } { timecode } { ticks }
export type TimeInput =
  | number
  | string
  | { seconds: number }
  | { frames: number }
  | { timecode: string }
  | { ticks: number }

export function toTicks(input: TimeInput, fps: Rational): Tick {
  if (typeof input === 'number') return secondsToTicks(input)
  if (typeof input === 'string') {
    const s = input.trim()
    let m = /^(-?\d+(?:\.\d+)?)\s*s$/.exec(s)
    if (m) return secondsToTicks(Number(m[1]))
    m = /^(-?\d+)\s*f$/.exec(s)
    if (m) return framesToTicks(Number(m[1]), fps)
    m = /^(-?\d+)\s*t$/.exec(s)
    if (m) return assertTick(Number(m[1]))
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return secondsToTicks(Number(s))
    return framesToTicks(timecodeToFrames(s, fps), fps)
  }
  if (input && typeof input === 'object') {
    if ('ticks' in input) return assertTick(input.ticks)
    if ('frames' in input) return framesToTicks(input.frames, fps)
    if ('timecode' in input) return framesToTicks(timecodeToFrames(input.timecode, fps), fps)
    if ('seconds' in input) return secondsToTicks(input.seconds)
  }
  throw new TimeError(`can't read a time from ${JSON.stringify(input)}`)
}

// how a time is shown to agents and in inspect output: all three views of one value
export function describeTime(t: Tick, fps: Rational): { ticks: Tick; seconds: number; timecode: string } {
  return { ticks: t, seconds: Math.round(ticksToSeconds(t) * 1e6) / 1e6, timecode: ticksToTimecode(t, fps) }
}
