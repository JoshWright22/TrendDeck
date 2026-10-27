import { describe, expect, it } from 'vitest'
import { createSegmenter, encodeWav, rms, VAD_SAMPLE_RATE, type Utterance } from './vad'

const FRAME = 2048
const tone = (amp: number): Float32Array => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3))
const quiet = (): Float32Array => new Float32Array(FRAME)
// frames for about this many seconds
const frames = (seconds: number): number => Math.round((seconds * VAD_SAMPLE_RATE) / FRAME)

function feed(plan: [number, number][], opts = {}): Utterance[] {
  const out: Utterance[] = []
  const seg = createSegmenter((u) => out.push(u), opts)
  for (const [amp, secs] of plan) for (let i = 0; i < frames(secs); i++) seg.push(amp ? tone(amp) : quiet())
  seg.flush()
  return out
}

describe('vad segmenter', () => {
  it('measures loudness', () => {
    expect(rms(quiet())).toBe(0)
    expect(rms(tone(0.5))).toBeGreaterThan(0.3)
  })

  it('cuts two utterances at a pause and none for silence', () => {
    const out = feed([
      [0, 1],
      [0.3, 1.5],
      [0, 1.5],
      [0.3, 1],
      [0, 2]
    ])
    expect(out).toHaveLength(2)
    expect(out[0].start).toBeGreaterThan(0.5)
    expect(out[0].start).toBeLessThan(1)
    expect(out[1].start).toBeGreaterThan(3.5)
    // trailing quiet is trimmed to about 0.2 s
    expect(out[0].end - out[0].start).toBeLessThan(2.3)
  })

  it('keeps a short pause inside one utterance', () => {
    expect(
      feed([
        [0.3, 1],
        [0, 0.5],
        [0.3, 1],
        [0, 2]
      ])
    ).toHaveLength(1)
  })

  it('drops a click shorter than the minimum speech', () => {
    expect(
      feed([
        [0, 1],
        [0.3, 0.1],
        [0, 2]
      ])
    ).toHaveLength(0)
  })

  it('cuts long speech at the maximum length', () => {
    const out = feed([[0.3, 12]], { maxSeconds: 5 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const u of out) expect(u.audio.length).toBeLessThanOrEqual(5 * VAD_SAMPLE_RATE + FRAME)
  })

  it('flush ends speech in progress', () => {
    const out: Utterance[] = []
    const seg = createSegmenter((u) => out.push(u))
    for (let i = 0; i < frames(1); i++) seg.push(tone(0.3))
    expect(seg.speaking).toBe(true)
    seg.flush()
    expect(out).toHaveLength(1)
    expect(seg.speaking).toBe(false)
  })

  it('writes a 16-bit wav', () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1])))
    expect(wav.byteLength).toBe(50)
    expect(wav.getUint32(24, true)).toBe(16000)
    expect(wav.getInt16(46, true)).toBe(32767)
    expect(wav.getInt16(48, true)).toBe(-32768)
  })
})
