// turning what providers give back into words with times
import type { SttResult, SttWord } from './types'

export interface TimedSegment {
  text: string
  start: number
  end: number
}

function finite(n: unknown): number | undefined {
  const v = typeof n === 'string' && n.trim() ? Number(n) : n
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// one word if its text and times hold up, else nothing
export function word(text: unknown, start: unknown, end: unknown, scale = 1): SttWord | undefined {
  const t = typeof text === 'string' ? text.trim() : ''
  const s = finite(start)
  const e = finite(end)
  if (!t || s === undefined || e === undefined) return undefined
  const a = s * scale
  const b = e * scale
  if (a < 0 || b < a) return undefined
  return { text: t, start: round(a), end: round(b) }
}

export function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

// only segment times: spread each segment's words by character length. approximate
export function spreadSegments(segments: TimedSegment[]): SttWord[] {
  const out: SttWord[] = []
  for (const seg of segments) {
    if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.end < seg.start) continue
    const parts = seg.text.split(/\s+/).filter(Boolean)
    const total = parts.reduce((sum, p) => sum + p.length, 0)
    if (!total) continue
    const span = seg.end - seg.start
    let at = seg.start
    for (const p of parts) {
      const end = at + (span * p.length) / total
      out.push({ text: p, start: round(at), end: round(end) })
      at = end
    }
  }
  return out
}

// punctuation that a provider hands back as its own token, glued onto the word before it
export function attachToPrevious(words: SttWord[], punct: string): void {
  const last = words[words.length - 1]
  if (last) last.text += punct
}

export function joinWords(words: SttWord[]): string {
  return words.map((w) => w.text).join(' ')
}

// the result from exact words, from segments (approximate) or from text alone (no times)
export function result(text: string, words: SttWord[], segments: TimedSegment[], language?: string): SttResult {
  const clean = text.trim()
  if (words.length) return { text: clean, words, language: lang(language), wordTimesApproximate: false }
  const spread = spreadSegments(segments)
  return { text: clean, words: spread, language: lang(language), wordTimesApproximate: !!clean }
}

// Whisper servers say "english", the rest "en" or "en-US". only codes go out
const NAMES: Record<string, string> = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl',
  russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', hindi: 'hi', turkish: 'tr',
  polish: 'pl', ukrainian: 'uk', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
  czech: 'cs', hebrew: 'he', indonesian: 'id', vietnamese: 'vi', thai: 'th', romanian: 'ro', hungarian: 'hu'
}

export function lang(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim()
  if (/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(v)) return v.replace(/_/g, '-')
  return NAMES[v.toLowerCase()]
}

// "1.500s" (protobuf Duration in JSON) to seconds
export function duration(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim())
  return m ? Number(m[1]) : undefined
}

// the length of a PCM WAV from its header, undefined when it isn't one
export function wavSeconds(audio: ArrayBuffer): number | undefined {
  if (audio.byteLength < 44) return undefined
  const view = new DataView(audio)
  const tag = (at: number): string => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let byteRate = 0
  let at = 12
  while (at + 8 <= audio.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 16 <= audio.byteLength) byteRate = view.getUint32(at + 16, true)
    if (id === 'data') {
      if (!byteRate) return undefined
      const bytes = Math.min(size, audio.byteLength - at - 8)
      return bytes / byteRate
    }
    at += 8 + size + (size % 2)
  }
  return undefined
}
