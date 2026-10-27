import { evalEffect, evalParam } from './effects'
import { transitionSpan } from './commands/effect'
import { itemEnd, type Id, type ParamScalar, type Project, type SequenceItem, type Track, type TrackItem, type Transition } from './model'
import type { Tick } from './time'

// what plays when. the preview in the renderer and the ffmpeg export both read the timeline
// through these, so they agree on transitions, fades and keyframes

export interface ClipSpan {
  clip: TrackItem
  // when the clip is on screen, widened past its edges by transitions on either cut
  visibleStart: Tick
  visibleEnd: Tick
  // the transition into this clip, as a timeline range
  transition: { def: Transition; start: Tick; end: Tick; fromClipId: Id | null } | null
}

export function clipSpans(track: Track): ClipSpan[] {
  const out: ClipSpan[] = []
  for (let i = 0; i < track.items.length; i++) {
    const c = track.items[i]
    const prev = track.items[i - 1]
    const next = track.items[i + 1]
    let visibleStart = c.start
    let visibleEnd = itemEnd(c)
    let transition: ClipSpan['transition'] = null
    if (c.transitionIn) {
      const { before, after } = transitionSpan(c.transitionIn.duration, c.transitionIn.alignment)
      visibleStart = c.start - before
      const adjacent = prev && itemEnd(prev) === c.start ? prev : null
      transition = { def: c.transitionIn, start: c.start - before, end: c.start + after, fromClipId: adjacent?.id ?? null }
    }
    if (next?.transitionIn && next.start === itemEnd(c)) {
      visibleEnd = itemEnd(c) + transitionSpan(next.transitionIn.duration, next.transitionIn.alignment).after
    }
    out.push({ clip: c, visibleStart: Math.max(0, visibleStart), visibleEnd, transition })
  }
  return out
}

// source time of a clip at timeline time t. works outside the clip edges for transition handles
export function sourceTimeAt(c: TrackItem, t: Tick): Tick {
  return c.sourceIn + Math.round((t - c.start) * c.speed)
}

// 0..1 multiplier from the fade effect at timeline time t
export function fadeAt(c: TrackItem, t: Tick): number {
  let m = 1
  for (const fx of c.effects) {
    if (!fx.enabled || fx.defId !== 'fade') continue
    const fi = Number(evalParam(fx.params.fade_in, 0, 0))
    const fo = Number(evalParam(fx.params.fade_out, 0, 0))
    if (fi > 0) m = Math.min(m, Math.max(0, (t - c.start) / fi))
    if (fo > 0) m = Math.min(m, Math.max(0, (itemEnd(c) - t) / fo))
  }
  return Math.min(1, m)
}

export interface ResolvedEffect {
  defId: string
  params: Record<string, ParamScalar>
}

export interface ResolvedVideoLayer {
  kind: 'clip'
  clipId: Id
  trackId: Id
  itemRef: Id
  // the media actually decoded, after following subclips. null for graphics and sequences
  mediaId: Id | null
  // time inside mediaId (or inside the graphic/sequence itself)
  time: Tick
  // fades and transitions, multiply into the transform opacity
  opacity: number
  effects: ResolvedEffect[]
}

export interface ResolvedSolid {
  kind: 'solid'
  color: string
  opacity: number
}

export interface ResolvedAudio {
  clipId: Id
  trackId: Id
  mediaId: Id | null
  time: Tick
  // linear gain including fades and the volume effect
  gain: number
}

export interface ResolvedFrame {
  time: Tick
  width: number
  height: number
  // bottom to top
  video: (ResolvedVideoLayer | ResolvedSolid)[]
  audio: ResolvedAudio[]
  captions: { trackId: Id; cueId: Id; text: string; style: Record<string, ParamScalar> }[]
}

function follow(p: Project, c: TrackItem, t: Tick): { mediaId: Id | null; time: Tick } {
  const src = sourceTimeAt(c, t)
  const it = p.items[c.itemRef]
  if (it?.kind === 'media') return { mediaId: it.id, time: src }
  if (it?.kind === 'subclip') return { mediaId: it.sourceId, time: it.in + src }
  return { mediaId: null, time: src }
}

// transition blend for a clip at t: the incoming clip ramps up, dips fade the outgoing one too
function transitionMix(span: ClipSpan, spans: ClipSpan[], t: Tick): { opacity: number; solid: ResolvedSolid | null } {
  let opacity = 1
  let solid: ResolvedSolid | null = null
  const tr = span.transition
  if (tr && t >= tr.start && t < tr.end) {
    const x = (t - tr.start) / (tr.end - tr.start)
    if (tr.def.defId === 'dip_to_color') {
      opacity = Math.max(0, 2 * x - 1)
      solid = { kind: 'solid', color: String(tr.def.params.color ?? '#000000'), opacity: 1 - Math.abs(2 * x - 1) }
    } else opacity = x
  }
  // an outgoing clip under a dip fades out in the first half
  const next = spans.find((s) => s.transition?.fromClipId === span.clip.id)
  if (next?.transition && next.transition.def.defId === 'dip_to_color' && t >= next.transition.start && t < next.transition.end) {
    const x = (t - next.transition.start) / (next.transition.end - next.transition.start)
    opacity *= Math.max(0, 1 - 2 * x)
  }
  return { opacity, solid }
}

export function resolveFrame(p: Project, seq: SequenceItem, t: Tick): ResolvedFrame {
  const video: ResolvedFrame['video'] = []
  for (const track of seq.videoTracks) {
    if (track.hidden) continue
    const spans = clipSpans(track)
    for (const span of spans) {
      const c = span.clip
      if (!c.enabled || t < span.visibleStart || t >= span.visibleEnd) continue
      const { mediaId, time } = follow(p, c, t)
      const mix = transitionMix(span, spans, t)
      if (mix.solid) video.push(mix.solid)
      video.push({
        kind: 'clip',
        clipId: c.id,
        trackId: track.id,
        itemRef: c.itemRef,
        mediaId,
        time,
        opacity: mix.opacity * fadeAt(c, t),
        effects: c.effects.filter((fx) => fx.enabled && fx.defId !== 'fade').map((fx) => ({ defId: fx.defId, params: evalEffect(fx, sourceTimeAt(c, t)) }))
      })
    }
  }
  const audio: ResolvedAudio[] = []
  for (const track of seq.audioTracks) {
    if (track.muted) continue
    const spans = clipSpans(track)
    for (const span of spans) {
      const c = span.clip
      if (!c.enabled || t < span.visibleStart || t >= span.visibleEnd) continue
      const { mediaId, time } = follow(p, c, t)
      let gain = transitionMix(span, spans, t).opacity * fadeAt(c, t)
      for (const fx of c.effects) {
        if (fx.enabled && fx.defId === 'volume') gain *= Math.pow(10, Number(evalParam(fx.params.gain, 0, sourceTimeAt(c, t))) / 20)
      }
      audio.push({ clipId: c.id, trackId: track.id, mediaId, time, gain })
    }
  }
  const captions: ResolvedFrame['captions'] = []
  for (const ct of seq.captionTracks) {
    if (ct.hidden) continue
    const cue = ct.cues.find((c) => c.start <= t && t < c.start + c.duration)
    if (cue) captions.push({ trackId: ct.id, cueId: cue.id, text: cue.text, style: ct.style })
  }
  return { time: t, width: seq.width, height: seq.height, video, audio, captions }
}
