// voice activity: cuts a stream of 16 kHz mono frames into utterances at pauses, so hands-free
// dictation can transcribe each one while you keep talking. pure, the composer feeds it frames
// from an audio worklet and the tests feed it made-up ones

export const VAD_SAMPLE_RATE = 16000

export interface VadOptions {
  // a frame this loud (RMS, 0 to 1) counts as speech. about -40 dB
  threshold: number
  // seconds of quiet that end an utterance
  pause: number
  // seconds of quiet kept before speech starts, so the first syllable isn't clipped
  preroll: number
  // an utterance is cut here even mid-sentence, Whisper reads 30 s at a time
  maxSeconds: number
  // less speech than this is a click or a bump, dropped
  minSpeech: number
}

export const DEFAULT_VAD: VadOptions = { threshold: 0.012, pause: 1.1, preroll: 0.3, maxSeconds: 25, minSpeech: 0.25 }

export interface Utterance {
  audio: Float32Array
  // seconds from when the segmenter started
  start: number
  end: number
}

export interface Segmenter {
  push(frame: Float32Array): void
  // ends the current utterance now, e.g. when you stop the mic
  flush(): void
  // true while it's inside an utterance
  readonly speaking: boolean
  // the loudness of the last frame, for a level meter
  readonly level: number
}

export function rms(frame: Float32Array): number {
  if (!frame.length) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function join(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export function createSegmenter(onUtterance: (u: Utterance) => void, options: Partial<VadOptions> = {}): Segmenter {
  const o = { ...DEFAULT_VAD, ...options }
  let frames: Float32Array[] = []
  let preroll: Float32Array[] = []
  let prerollSamples = 0
  let samples = 0
  let quietSamples = 0
  let speechSamples = 0
  // samples seen before the current utterance's first frame
  let clock = 0
  let startAt = 0
  let level = 0

  const emit = (): void => {
    if (frames.length && speechSamples >= o.minSpeech * VAD_SAMPLE_RATE) {
      // the trailing quiet isn't part of what was said
      const keep = Math.max(0, samples - Math.max(0, quietSamples - 0.2 * VAD_SAMPLE_RATE))
      const audio = join(frames).subarray(0, keep)
      onUtterance({ audio: audio.slice(), start: startAt / VAD_SAMPLE_RATE, end: (startAt + keep) / VAD_SAMPLE_RATE })
    }
    frames = []
    samples = 0
    quietSamples = 0
    speechSamples = 0
  }

  return {
    get speaking() {
      return frames.length > 0
    },
    get level() {
      return level
    },
    push(frame) {
      level = rms(frame)
      const loud = level >= o.threshold
      if (!frames.length) {
        if (!loud) {
          preroll.push(frame)
          prerollSamples += frame.length
          while (preroll.length > 1 && prerollSamples - preroll[0].length >= o.preroll * VAD_SAMPLE_RATE) {
            prerollSamples -= preroll[0].length
            preroll.shift()
          }
          clock += frame.length
          return
        }
        frames = preroll
        samples = prerollSamples
        startAt = clock - prerollSamples
        preroll = []
        prerollSamples = 0
      }
      frames.push(frame)
      samples += frame.length
      clock += frame.length
      if (loud) {
        speechSamples += frame.length
        quietSamples = 0
      } else quietSamples += frame.length
      if (quietSamples >= o.pause * VAD_SAMPLE_RATE || samples >= o.maxSeconds * VAD_SAMPLE_RATE) emit()
    },
    flush: emit
  }
}

// float samples to a 16-bit wav, for the API mode and for saving a dump
export function encodeWav(pcm: Float32Array, sampleRate = VAD_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}
