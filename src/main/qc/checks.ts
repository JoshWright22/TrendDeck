import type { QcCheck, QcTarget } from '@shared/qc'

// the pure half of the checks: reading ffmpeg's log lines and turning numbers into pass, warn
// or fail. no electron and no processes, so the tests run it on plain strings

export interface VideoInfo {
  duration: number
  width: number
  height: number
  fps: number
  videoCodec: string
  pixFmt: string
  audioCodec: string
  container: string
}

export interface Span {
  start: number
  end: number
}

// loudness, from the ebur128 filter's summary
export interface Loudness {
  integrated: number | null
  truePeak: number | null
  range: number | null
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : s.trim() === '-inf' ? -Infinity : null
}

// the summary ebur128 prints when it's done. the per frame lines are logged at verbose, so they
// aren't in the text at all, and only the last summary counts if there are several
export function parseLoudness(stderr: string): Loudness {
  const at = stderr.lastIndexOf('Summary:')
  const tail = at >= 0 ? stderr.slice(at) : ''
  const integrated = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(tail)?.[1]
  const peak = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(tail)?.[1]
  const range = /Loudness range:\s*\n\s*LRA:\s*(-?[\d.]+)\s*LU/.exec(tail)?.[1]
  return { integrated: num(integrated), truePeak: num(peak), range: num(range) }
}

// silencedetect: "silence_start: 1.5" then "silence_end: 3.5 | silence_duration: 2".
// a silence still going when the file ends has no end line, it runs to the end
export function parseSilences(stderr: string, duration: number): Span[] {
  const out: Span[] = []
  let open: number | null = null
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]))
    if (m[1] === 'start') open = t
    else if (open !== null) {
      out.push({ start: open, end: t })
      open = null
    }
  }
  if (open !== null) out.push({ start: open, end: Math.max(open, duration) })
  return out
}

// blackdetect: "black_start:0 black_end:2.5 black_duration:2.5"
export function parseBlack(stderr: string): Span[] {
  const out: Span[] = []
  for (const m of stderr.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)) {
    out.push({ start: Math.max(0, Number(m[1])), end: Number(m[2]) })
  }
  return out
}

// freezedetect logs its metadata: "lavfi.freezedetect.freeze_start: 1.2" and later
// "lavfi.freezedetect.freeze_end: 4.3". one with no end runs to the end of the file
export function parseFreezes(stderr: string, duration: number): Span[] {
  const out: Span[] = []
  let open: number | null = null
  for (const m of stderr.matchAll(/freeze_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]))
    if (m[1] === 'start') open = t
    else if (open !== null) {
      out.push({ start: open, end: t })
      open = null
    }
  }
  if (open !== null) out.push({ start: open, end: Math.max(open, duration) })
  return out
}

// metadata=print after select: a "frame:N pts:... pts_time:T" line, then "lavfi.scene_score=S"
export function parseSceneScores(stderr: string): { t: number; score: number }[] {
  const out: { t: number; score: number }[] = []
  let t: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const time = /pts_time:\s*(-?[\d.]+)/.exec(line)
    if (time) {
      t = Number(time[1])
      continue
    }
    const s = /lavfi\.scene_score=\s*([\d.]+)/.exec(line)
    if (s && t !== null) {
      out.push({ t, score: Number(s[1]) })
      t = null
    }
  }
  return out
}

// -progress pipe:1 writes key=value lines, out_time_us is how far it got
export function parseProgressTime(chunk: string): number | null {
  let last: number | null = null
  for (const m of chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)) last = Number(m[1]) / 1e6
  return last
}

// captions: the text of a .srt or .vtt without numbers, times, tags or the WEBVTT header
export function captionText(raw: string): { text: string; end: number } {
  const lines: string[] = []
  let end = 0
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const l = line.trim()
    const time = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(l)
    if (time) {
      end = Math.max(end, Number(time[5] ?? 0) * 3600 + Number(time[6]) * 60 + Number(time[7]) + Number(time[8].padEnd(3, '0')) / 1000)
      continue
    }
    if (!l || /^\d+$/.test(l) || /^WEBVTT/.test(l) || /^(NOTE|STYLE|REGION)\b/.test(l)) continue
    lines.push(l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, ''))
  }
  return { text: lines.join(' '), end }
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
}

// word error rate of the captions against the transcript: substitutions, deletions and
// insertions over the transcript's word count. a plain edit distance over words
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = words(reference)
  const h = words(hypothesis)
  if (r.length === 0) return h.length === 0 ? 0 : 1
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[h.length] / r.length
}

// the target a video looks made for, when nobody said
export function guessTarget(info: Pick<VideoInfo, 'width' | 'height'>): QcTarget {
  const { width: w, height: h } = info
  if (!w || !h) return 'youtube'
  if (Math.abs(w / h - 1) < 0.02) return 'square'
  return h > w ? 'shorts' : 'youtube'
}

// limits per target. lengths in seconds
export const TARGET_SPECS: Record<QcTarget, { aspect: number; aspectName: string; ideal: [number, number]; min: [number, number]; maxLen: number; warnLen: number }> = {
  // YouTube takes up to 12 hours, anything past 1 hour is worth a second look
  youtube: { aspect: 16 / 9, aspectName: '16:9', ideal: [1920, 1080], min: [1280, 720], maxLen: 12 * 3600, warnLen: 3600 },
  // Shorts and Reels take up to 3 minutes, TikTok more. Past 60 seconds some surfaces cut it
  shorts: { aspect: 9 / 16, aspectName: '9:16', ideal: [1080, 1920], min: [720, 1280], maxLen: 180, warnLen: 60 },
  square: { aspect: 1, aspectName: '1:1', ideal: [1080, 1080], min: [720, 720], maxLen: 600, warnLen: 180 }
}

export const LOUDNESS_RANGE: [number, number] = [-16, -12]
export const TRUE_PEAK_MAX = -1
// how long a quiet stretch, black stretch or still picture has to last to count
export const SILENCE_MIN = 2
export const BLACK_MIN = 0.5
export const FREEZE_MIN = 2
export const HOOK_SECONDS = 3
// a scene score above this between two frames is a cut
export const CUT_SCORE = 0.3
// average scene score in the hook above this counts as movement even without a cut
export const MOTION_SCORE = 0.015

const secs = (t: number): string => {
  if (t < 60) return `${t.toFixed(1).replace(/\.0$/, '')}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
const at = (spans: Span[]): number[] => spans.map((s) => Math.round(s.start * 100) / 100)
const listAt = (spans: Span[]): string => {
  const shown = spans.slice(0, 5).map((s) => `${secs(s.start)} (${secs(s.end - s.start)})`)
  return spans.length > 5 ? `${shown.join(', ')} and ${spans.length - 5} more` : shown.join(', ')
}

export function checkFormat(info: VideoInfo): QcCheck {
  const label = 'Format'
  if (!info.videoCodec) return { id: 'format', label, status: 'fail', detail: 'No video track' }
  const issues: string[] = []
  let status: QcCheck['status'] = 'pass'
  if (!['h264', 'hevc', 'vp9', 'av1'].includes(info.videoCodec)) {
    issues.push(`${info.videoCodec} video, upload sites want H.264, HEVC, VP9 or AV1`)
    status = 'warn'
  }
  if (info.pixFmt && !/^yuv420p|^yuvj420p|^nv12/.test(info.pixFmt)) {
    issues.push(`${info.pixFmt} pixels, some players need yuv420p`)
    status = 'warn'
  }
  if (!info.audioCodec) {
    issues.push('no sound track')
    status = 'warn'
  } else if (!['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac', 'pcm_s16le'].includes(info.audioCodec)) {
    issues.push(`${info.audioCodec} audio, AAC is safest`)
    status = 'warn'
  }
  const what = `${info.videoCodec.toUpperCase()}${info.audioCodec ? ` and ${info.audioCodec.toUpperCase()}` : ''}`
  return { id: 'format', label, status, detail: issues.length ? issues.join('; ') : what }
}

export function checkResolution(info: VideoInfo, target: QcTarget): QcCheck {
  const spec = TARGET_SPECS[target]
  const label = 'Size'
  const { width: w, height: h } = info
  if (!w || !h) return { id: 'resolution', label, status: 'fail', detail: "Couldn't read the picture size" }
  const size = `${w}x${h}`
  if (Math.abs(w / h / spec.aspect - 1) > 0.01) {
    return { id: 'resolution', label, status: 'fail', detail: `${size} isn't ${spec.aspectName}` }
  }
  const [iw, ih] = spec.ideal
  const [mw, mh] = spec.min
  if (target === 'shorts' ? w === iw && h === ih : w >= iw && h >= ih) return { id: 'resolution', label, status: 'pass', detail: size }
  if (w >= mw && h >= mh) {
    return { id: 'resolution', label, status: 'warn', detail: target === 'shorts' ? `${size}, ${iw}x${ih} is what the apps show best` : `${size}, ${iw}x${ih} or more looks sharper` }
  }
  return { id: 'resolution', label, status: 'fail', detail: `${size} is below ${mw}x${mh}` }
}

export function checkFps(info: VideoInfo): QcCheck {
  const label = 'Frame rate'
  const f = info.fps
  if (!f) return { id: 'fps', label, status: 'warn', detail: "Couldn't read the frame rate" }
  const shown = `${Math.round(f * 100) / 100} fps`
  if (f < 23.5) return { id: 'fps', label, status: 'warn', detail: `${shown}, motion looks choppy under 24` }
  if (f > 61) return { id: 'fps', label, status: 'warn', detail: `${shown}, most sites play 60 at most` }
  return { id: 'fps', label, status: 'pass', detail: shown }
}

export function checkDuration(info: VideoInfo, target: QcTarget): QcCheck {
  const spec = TARGET_SPECS[target]
  const label = 'Length'
  const d = info.duration
  if (d < 1) return { id: 'duration', label, status: 'fail', detail: d > 0 ? `${secs(d)} is too short` : "Couldn't read the length" }
  if (d > spec.maxLen) return { id: 'duration', label, status: 'fail', detail: `${secs(d)}, over the ${secs(spec.maxLen)} limit` }
  if (d > spec.warnLen) {
    const why = target === 'shorts' ? 'over 60s, some apps cut it or won\'t show it as a short' : `over ${secs(spec.warnLen)}`
    return { id: 'duration', label, status: 'warn', detail: `${secs(d)}, ${why}` }
  }
  return { id: 'duration', label, status: 'pass', detail: secs(d) }
}

export function checkLoudness(l: Loudness, hasAudio: boolean): QcCheck[] {
  if (!hasAudio) return [{ id: 'loudness', label: 'Loudness', status: 'warn', detail: 'No sound track' }]
  const out: QcCheck[] = []
  const [lo, hi] = LOUDNESS_RANGE
  const i = l.integrated
  if (i === null) out.push({ id: 'loudness', label: 'Loudness', status: 'warn', detail: "Couldn't measure it" })
  else if (!Number.isFinite(i)) out.push({ id: 'loudness', label: 'Loudness', status: 'fail', detail: 'Silent the whole way through' })
  else {
    const v = `${i.toFixed(1)} LUFS`
    if (i < lo) out.push({ id: 'loudness', label: 'Loudness', status: 'warn', detail: `${v}, quieter than ${lo}, it'll sound weak next to other videos` })
    else if (i > hi) out.push({ id: 'loudness', label: 'Loudness', status: 'warn', detail: `${v}, louder than ${hi}, sites will turn it down` })
    else out.push({ id: 'loudness', label: 'Loudness', status: 'pass', detail: v })
  }
  const p = l.truePeak
  if (p === null) out.push({ id: 'true-peak', label: 'Peaks', status: 'warn', detail: "Couldn't measure them" })
  else if (!Number.isFinite(p) || p <= TRUE_PEAK_MAX) {
    out.push({ id: 'true-peak', label: 'Peaks', status: 'pass', detail: Number.isFinite(p) ? `${p.toFixed(1)} dBTP` : 'Silent' })
  } else {
    out.push({
      id: 'true-peak',
      label: 'Peaks',
      status: p > 0 ? 'fail' : 'warn',
      detail: `${p.toFixed(1)} dBTP, over ${TRUE_PEAK_MAX}${p > 0 ? ', it clips' : ', may distort after the site re-encodes it'}`
    })
  }
  return out
}

export function checkSilences(spans: Span[], duration: number, hasAudio: boolean): QcCheck {
  const label = 'Silences'
  if (!hasAudio) return { id: 'silence', label, status: 'warn', detail: 'No sound track' }
  const long = spans.filter((s) => s.end - s.start >= SILENCE_MIN)
  if (long.length === 0) return { id: 'silence', label, status: 'pass', detail: `None over ${SILENCE_MIN}s` }
  const total = long.reduce((n, s) => n + s.end - s.start, 0)
  if (duration > 0 && total >= duration * 0.9) return { id: 'silence', label, status: 'fail', detail: 'Silent almost the whole way through', at: at(long) }
  return { id: 'silence', label, status: 'warn', detail: `${long.length} quiet ${long.length === 1 ? 'stretch' : 'stretches'}: ${listAt(long)}`, at: at(long) }
}

export function checkBlack(spans: Span[], duration: number): QcCheck {
  const label = 'Black frames'
  const long = spans.filter((s) => s.end - s.start >= BLACK_MIN)
  if (long.length === 0) return { id: 'black', label, status: 'pass', detail: 'None' }
  const total = long.reduce((n, s) => n + s.end - s.start, 0)
  if (duration > 0 && total >= duration * 0.9) return { id: 'black', label, status: 'fail', detail: 'Black almost the whole way through', at: at(long) }
  return { id: 'black', label, status: 'warn', detail: `${long.length} black ${long.length === 1 ? 'stretch' : 'stretches'}: ${listAt(long)}`, at: at(long) }
}

export function checkFreezes(spans: Span[], duration: number): QcCheck {
  const label = 'Frozen picture'
  const long = spans.filter((s) => s.end - s.start >= FREEZE_MIN)
  if (long.length === 0) return { id: 'frozen', label, status: 'pass', detail: `None over ${FREEZE_MIN}s` }
  const total = long.reduce((n, s) => n + s.end - s.start, 0)
  if (duration > 0 && total >= duration * 0.9) return { id: 'frozen', label, status: 'warn', detail: 'A still picture the whole way through', at: at(long) }
  return { id: 'frozen', label, status: 'warn', detail: `${long.length} still ${long.length === 1 ? 'stretch' : 'stretches'}: ${listAt(long)}`, at: at(long) }
}

// the first seconds decide whether people keep watching: a cut or real movement in them
export function checkHook(scores: { t: number; score: number }[]): QcCheck {
  const label = `First ${HOOK_SECONDS} seconds`
  const early = scores.filter((s) => s.t <= HOOK_SECONDS)
  if (early.length < 2) return { id: 'hook', label, status: 'warn', detail: "Couldn't read the opening" }
  const cuts = early.filter((s) => s.t > 0.05 && s.score >= CUT_SCORE)
  if (cuts.length) {
    return { id: 'hook', label, status: 'pass', detail: `${cuts.length} ${cuts.length === 1 ? 'cut' : 'cuts'}`, at: cuts.map((c) => Math.round(c.t * 100) / 100) }
  }
  const motion = early.reduce((n, s) => n + s.score, 0) / early.length
  if (motion >= MOTION_SCORE) return { id: 'hook', label, status: 'pass', detail: 'Moving, no cut' }
  return { id: 'hook', label, status: 'warn', detail: 'No cut and little movement, people may scroll past' }
}

export function checkCaptions(captions: string, transcript: string, duration: number, names: { captions: string; transcript: string }): QcCheck {
  const label = 'Captions'
  const cap = captionText(captions)
  const wer = wordErrorRate(transcript, cap.text)
  const pct = `${Math.round(wer * 1000) / 10}%`
  const late = duration > 0 && cap.end > duration + 0.5
  const tail = late ? `, and they run past the end of the video (${secs(cap.end)})` : ''
  const vs = `${names.captions} against ${names.transcript}`
  if (wer <= 0.05 && !late) return { id: 'captions', label, status: 'pass', detail: `${pct} word errors, ${vs}` }
  if (wer <= 0.15) return { id: 'captions', label, status: 'warn', detail: `${pct} word errors, ${vs}${tail}` }
  return { id: 'captions', label, status: 'fail', detail: `${pct} word errors, ${vs}${tail}` }
}
