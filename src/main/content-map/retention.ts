import type { MappedDip, Pacing, RetentionPoint, RetentionSummary, TextSource } from '@shared/content-map'
import type { SpokenWord } from '@shared/speech'

// where people left: dips on the retention curve turned into timestamps and matched to what was
// said there. YouTube's curve is audienceWatchRatio by elapsedVideoTimeRatio, about 100 points.
// pure, tested

export interface Dip {
  from: number
  to: number
  drop: number
  steepness: number
}

const INTRO_RATIO = 0.03
const MIN_DROP = 0.015
const MAX_DIPS = 5

export function cleanCurve(points: RetentionPoint[]): RetentionPoint[] {
  return points
    .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch) && p.ratio >= 0 && p.ratio <= 1 && p.watch >= 0)
    .sort((a, b) => a.ratio - b.ratio)
}

// the share still watching at a time, linear between points
export function watchAt(points: RetentionPoint[], ratio: number): number | null {
  const c = cleanCurve(points)
  if (!c.length) return null
  if (ratio <= c[0].ratio) return c[0].watch
  for (let i = 1; i < c.length; i++) {
    if (c[i].ratio >= ratio) {
      const a = c[i - 1]
      const b = c[i]
      const t = b.ratio === a.ratio ? 0 : (ratio - a.ratio) / (b.ratio - a.ratio)
      return a.watch + (b.watch - a.watch) * t
    }
  }
  return c[c.length - 1].watch
}

// steps that lose much more than the curve's usual step. the first 3% is the intro and always
// falls fast, YouTube reports it apart. neighbouring steep steps make one dip
export function findDips(points: RetentionPoint[], duration: number): Dip[] {
  const c = cleanCurve(points)
  if (c.length < 8 || !(duration > 0)) return []
  const steps: { i: number; loss: number; per: number }[] = []
  for (let i = 1; i < c.length; i++) {
    if (c[i].ratio <= INTRO_RATIO) continue
    const width = c[i].ratio - c[i - 1].ratio
    if (width <= 0) continue
    const loss = c[i - 1].watch - c[i].watch
    steps.push({ i, loss, per: loss / width })
  }
  if (!steps.length) return []
  // the usual decline per unit of the video, a floor so a flat curve doesn't make noise into dips
  const usual = Math.max(0.05, median(steps.map((s) => Math.max(0, s.per))) ?? 0)
  const steep = steps.map((s) => ({ ...s, steep: s.per / usual }))
  const dips: Dip[] = []
  let run: typeof steep = []
  const close = (): void => {
    if (!run.length) return
    const first = run[0]
    const last = run[run.length - 1]
    const drop = c[first.i - 1].watch - c[last.i].watch
    if (drop >= MIN_DROP) {
      dips.push({
        from: c[first.i - 1].ratio * duration,
        to: c[last.i].ratio * duration,
        drop,
        steepness: Math.round(Math.max(...run.map((r) => r.steep)) * 10) / 10
      })
    }
    run = []
  }
  for (const s of steep) {
    if (s.steep >= 2.5 && s.loss > 0) run.push(s)
    else close()
  }
  close()
  // the tail always drops as people reach the end screen, the last 4% isn't a dip
  return dips
    .filter((d) => d.from < duration * 0.96)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, MAX_DIPS)
    .sort((a, b) => a.from - b.from)
}

// rises: people skipping back to rewatch
export function findSpikes(points: RetentionPoint[], duration: number): { at: number; rise: number }[] {
  const c = cleanCurve(points)
  const out: { at: number; rise: number }[] = []
  for (let i = 1; i < c.length; i++) {
    const rise = c[i].watch - c[i - 1].watch
    if (rise >= 0.02 && c[i].ratio > INTRO_RATIO) out.push({ at: c[i].ratio * duration, rise })
  }
  return out.sort((a, b) => b.rise - a.rise).slice(0, 3)
}

function median(v: number[]): number | null {
  const s = [...v].sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------- lines with times ----------

export interface TimedLine {
  text: string
  from: number
  to: number
  source: TextSource
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/
function secs(m: RegExpMatchArray): number {
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? '0'}`))
}

// srt or vtt cues with their times
export function parseCues(raw: string): TimedLine[] {
  const out: TimedLine[] = []
  const blocks = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const b of blocks) {
    const lines = b.split('\n')
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [a, z] = lines[ti].split('-->')
    const ma = a.match(TIME)
    const mz = z?.match(TIME)
    if (!ma || !mz) continue
    const text = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    // rolled up auto captions repeat the line before
    if (out.length && out[out.length - 1].text === text) {
      out[out.length - 1].to = secs(mz)
      continue
    }
    out.push({ text, from: secs(ma), to: secs(mz), source: 'transcript' })
  }
  return out
}

const norm = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// the script line that best matches a caption's words, '' when nothing is close
export function bestScriptLine(text: string, script: string[]): string {
  const tw = new Set(norm(text))
  if (!tw.size) return ''
  let best = ''
  let bestScore = 0
  for (const line of script) {
    const lw = norm(line)
    if (!lw.length) continue
    const hit = lw.filter((w) => tw.has(w)).length / Math.min(lw.length, tw.size)
    if (hit > bestScore) {
      best = line
      bestScore = hit
    }
  }
  return bestScore >= 0.5 ? best : ''
}

// the line being said as the dip starts, or the one just before it
export function lineAt(lines: TimedLine[], from: number, to: number): TimedLine | null {
  const sorted = [...lines].sort((a, b) => a.from - b.from)
  const during = sorted.find((l) => l.from <= from + 0.5 && l.to >= from - 0.5)
  if (during) return during
  const inside = sorted.find((l) => l.from >= from && l.from <= to)
  if (inside) return inside
  const before = sorted.filter((l) => l.to <= from && from - l.to <= 3)
  return before[before.length - 1] ?? null
}

// dips with timestamps and what was said there. a caption line is swapped for the script line it
// matches when the project has a script, so the creator sees their own words
export function mapDips(dips: Dip[], lines: TimedLine[], script: string[] = []): MappedDip[] {
  return dips.map((d) => {
    const hit = lineAt(lines, d.from, d.to)
    let line = hit?.text ?? ''
    let lineSource: TextSource = hit?.source ?? ''
    if (hit && hit.source !== 'script' && script.length) {
      const s = bestScriptLine(hit.text, script)
      if (s) {
        line = s
        lineSource = 'script'
      }
    }
    return { from: round(d.from), to: round(d.to), drop: round(d.drop, 3), steepness: d.steepness, line, lineSource, recurring: false }
  })
}

const round = (n: number, places = 1): number => Math.round(n * 10 ** places) / 10 ** places

// a dip at the same point of the video (within 5% of its length) in other recent videos
export function markRecurring(dips: MappedDip[], duration: number, others: { dips: Dip[]; duration: number }[]): MappedDip[] {
  if (!(duration > 0)) return dips
  return dips.map((d) => {
    const at = d.from / duration
    const hits = others.filter((o) => o.duration > 0 && o.dips.some((x) => Math.abs(x.from / o.duration - at) <= 0.05)).length
    return { ...d, recurring: hits >= 2 }
  })
}

export function summarizeRetention(points: RetentionPoint[], duration: number | null, lines: TimedLine[], script: string[], others: { dips: Dip[]; duration: number }[] = []): RetentionSummary {
  if (!duration || points.length < 2) return { duration, at30: null, dips: [], spikes: [] }
  const at30 = duration >= 60 ? watchAt(points, 30 / duration) : null
  const dips = markRecurring(mapDips(findDips(points, duration), lines, script), duration, others)
  return { duration, at30: at30 === null ? null : round(at30, 3), dips, spikes: findSpikes(points, duration).map((s) => ({ at: round(s.at), rise: round(s.rise, 3) })) }
}

// ---------- hook and pacing ----------

export function hookFromWords(words: SpokenWord[], seconds = 30): string {
  return words
    .filter((w) => w.start < seconds)
    .map((w) => w.text.trim())
    .join(' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
}

export function hookFromLines(lines: TimedLine[], seconds = 30): string {
  return lines
    .filter((l) => l.from < seconds)
    .map((l) => l.text)
    .join(' ')
    .trim()
}

const PAUSE = 0.6

export function pacingFromWords(words: SpokenWord[], source: TextSource): Pacing | null {
  const w = words.filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end)).sort((a, b) => a.start - b.start)
  if (w.length < 20) return null
  const span = w[w.length - 1].end - w[0].start
  if (span < 10) return null
  let pauses = 0
  let longest = 0
  for (let i = 1; i < w.length; i++) {
    const gap = w[i].start - w[i - 1].end
    if (gap >= PAUSE) pauses++
    longest = Math.max(longest, gap)
  }
  return { wpm: Math.round((w.length / span) * 60), pausesPerMin: round((pauses / span) * 60), longestPause: round(Math.max(0, longest)), source, approximate: false }
}

// from caption cues: words spread over each cue, gaps between cues are the pauses
export function pacingFromLines(lines: TimedLine[]): Pacing | null {
  const words: SpokenWord[] = []
  for (const l of lines) {
    const ws = l.text.split(/\s+/).filter(Boolean)
    const step = ws.length ? (l.to - l.from) / ws.length : 0
    ws.forEach((text, i) => words.push({ text, start: l.from + i * step, end: l.from + (i + 1) * step }))
  }
  const p = pacingFromWords(words, 'transcript')
  return p ? { ...p, approximate: true } : null
}
