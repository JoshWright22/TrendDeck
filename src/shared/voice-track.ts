// a dictation as the video's voice: its words cut into the stretches where you talk, the pauses
// between them left out (a short breath stays), laid back to back on the timeline, with a
// caption for each line at the time you say it

export interface DumpWord {
  text: string
  start: number
  end: number
}

export interface VoiceDump {
  id: string
  words: DumpWord[]
}

// one stretch of talking: where it is in the dictation's audio and where it goes on the timeline
export interface VoiceSegment {
  dump: string
  sourceIn: number
  sourceOut: number
  at: number
  words: { text: string; start: number; end: number }[]
}

export interface VoiceCaption {
  start: number
  end: number
  text: string
}

export interface VoicePlan {
  segments: VoiceSegment[]
  captions: VoiceCaption[]
  // where the voice ends on the timeline
  end: number
}

export interface VoiceOptions {
  // a silence longer than this is cut
  pause?: number
  // kept before and after each stretch so words aren't clipped
  pad?: number
  // between stretches once the pause is gone
  breath?: number
  // caption lines
  maxChars?: number
  maxSeconds?: number
}

const ENDS = /[.!?]["')\]]*$/

export function planVoice(dumps: VoiceDump[], at = 0, o: VoiceOptions = {}): VoicePlan {
  const pause = o.pause ?? 0.6
  const pad = o.pad ?? 0.12
  const breath = o.breath ?? 0.15
  const maxChars = o.maxChars ?? 42
  const maxSeconds = o.maxSeconds ?? 4.5
  const segments: VoiceSegment[] = []
  let t = at
  for (const d of dumps) {
    const words = d.words.filter((w) => w.text.trim() && w.end > w.start)
    let run: DumpWord[] = []
    const flush = (): void => {
      if (!run.length) return
      const sourceIn = Math.max(0, run[0].start - pad)
      const sourceOut = run[run.length - 1].end + pad
      if (segments.length) t += breath
      segments.push({ dump: d.id, sourceIn, sourceOut, at: t, words: run.map((w) => ({ text: w.text, start: t + (w.start - sourceIn), end: t + (w.end - sourceIn) })) })
      t += sourceOut - sourceIn
      run = []
    }
    for (const w of words) {
      if (run.length && w.start - run[run.length - 1].end > pause) flush()
      run.push(w)
    }
    flush()
  }
  // captions from the words where they now sit, a line ends at a sentence, a cut, or when it's full
  const captions: VoiceCaption[] = []
  for (const s of segments) {
    let line: { text: string; start: number; end: number }[] = []
    const close = (): void => {
      if (!line.length) return
      captions.push({ start: line[0].start, end: line[line.length - 1].end, text: line.map((w) => w.text).join(' ') })
      line = []
    }
    for (const w of s.words) {
      const text = [...line.map((x) => x.text), w.text].join(' ')
      if (line.length && (text.length > maxChars || w.end - line[0].start > maxSeconds)) close()
      line.push(w)
      if (ENDS.test(w.text)) close()
    }
    close()
  }
  return { segments, captions, end: t }
}

const stamp = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`
}

export function toSrt(captions: VoiceCaption[]): string {
  return captions.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')
}
