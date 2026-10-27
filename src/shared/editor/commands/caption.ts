import { defineCommand, rawTime, seqTime, type CommandSpec } from '../command'
import { checkParam, paramDef } from '../effects'
import { createCaptionTrack } from '../factory'
import { itemEnd, sourceOut, type CaptionCue, type CaptionTrack, type Id, type Project, type SequenceItem, type TrackItem, type TranscriptWord } from '../model'
import { s } from '../schema'
import { secondsToTicks, snapToFrame, type Tick, type TimeInput } from '../time'
import { fail, getItem, getSequence, rippleDeleteRange, setItem } from '../timeline'
import { mergeRanges } from './clip'

type Style = Record<string, string | number | boolean>

function cleanStyle(style: Record<string, unknown> | undefined): Style {
  const out: Style = {}
  for (const [k, v] of Object.entries(style ?? {})) {
    const pd = paramDef('text_style', k) ?? fail(`text_style has no ${k}`)
    const r = checkParam(pd, v)
    if (!r.ok) fail(r.reason)
    out[k] = r.value
  }
  return out
}

function captionTrack(seq: SequenceItem, trackId: Id | undefined): CaptionTrack {
  if (trackId) return seq.captionTracks.find((t) => t.id === trackId) ?? fail(`no caption track ${trackId}`)
  return seq.captionTracks[0] ?? fail('sequence has no caption track, add one with caption.track_add')
}

function withTrack(seq: SequenceItem, ct: CaptionTrack): SequenceItem {
  return { ...seq, captionTracks: seq.captionTracks.map((t) => (t.id === ct.id ? ct : t)) }
}

function findCue(p: Project, cueId: Id): { seq: SequenceItem; track: CaptionTrack; cue: CaptionCue } {
  for (const it of Object.values(p.items)) {
    if (it.kind !== 'sequence') continue
    for (const t of it.captionTracks) {
      const cue = t.cues.find((c) => c.id === cueId)
      if (cue) return { seq: it, track: t, cue }
    }
  }
  return fail(`no caption ${cueId}`)
}

function putCue(track: CaptionTrack, cue: CaptionCue): CaptionTrack {
  if (cue.duration <= 0) fail('caption needs a length')
  if (cue.start < 0) fail('caption would start before zero')
  const others = track.cues.filter((c) => c.id !== cue.id)
  const hit = others.find((c) => c.start < cue.start + cue.duration && c.start + c.duration > cue.start)
  if (hit) fail(`caption would overlap ${hit.id}`)
  return { ...track, cues: [...others, cue].sort((a, b) => a.start - b.start) }
}

// a clip plays media M from media time `offset + sourceIn`. subclips add their in point
export function mediaOf(p: Project, c: TrackItem): { mediaId: Id; offset: Tick } | null {
  const it = p.items[c.itemRef]
  if (it?.kind === 'media') return { mediaId: it.id, offset: 0 }
  if (it?.kind === 'subclip' && p.items[it.sourceId]?.kind === 'media') return { mediaId: it.sourceId, offset: it.in }
  return null
}

interface Mapped {
  word: TranscriptWord
  start: Tick
  end: Tick
}

// where each transcript word lands on the timeline. audio clips win, video only fills in for
// media nobody plays the sound of. words clipped by the clip edges are clamped
export function mapWords(p: Project, seq: SequenceItem, mediaFilter?: Id): Mapped[] {
  const out: Mapped[] = []
  const pick = (tracks: SequenceItem['audioTracks'], skipLinks: Set<Id> | null): Set<Id> => {
    const links = new Set<Id>()
    for (const t of tracks) {
      if (t.muted && t.kind === 'audio') continue
      for (const c of t.items) {
        if (!c.enabled) continue
        if (skipLinks && c.linkId && skipLinks.has(c.linkId)) continue
        const m = mediaOf(p, c)
        if (!m || (mediaFilter && m.mediaId !== mediaFilter)) continue
        const media = p.items[m.mediaId]
        if (media?.kind !== 'media' || !media.transcript) continue
        if (c.linkId) links.add(c.linkId)
        const from = m.offset + c.sourceIn
        const to = m.offset + sourceOut(c)
        for (const w of media.transcript.words) {
          if (w.end <= from || w.start >= to) continue
          const ws = Math.max(w.start, from)
          const we = Math.min(w.end, to)
          out.push({
            word: w,
            start: c.start + Math.round((ws - from) / c.speed),
            end: Math.min(itemEnd(c), c.start + Math.round((we - from) / c.speed))
          })
        }
      }
    }
    return links
  }
  const audioLinks = pick(seq.audioTracks, null)
  pick(seq.videoTracks.filter((t) => !t.hidden), audioLinks)
  return out.sort((a, b) => a.start - b.start)
}

export const captionCommands: CommandSpec[] = [
  defineCommand<{ sequenceId: Id; name?: string; style?: Record<string, unknown> }>({
    id: 'caption.track_add',
    label: 'Add Caption Track',
    menuPath: ['Sequence', 'Add Caption Track'],
    shortcut: null,
    doc: 'Adds a caption track; style keys come from text_style. Returns { trackId }.',
    params: s.object({ sequenceId: s.string('Sequence id.'), name: s.optional(s.string('Name.')), style: s.optional({ type: 'object', description: 'text_style values.' }) }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const id = ctx.newId('ctrack')
      const ct = createCaptionTrack(id, a.name ?? `Captions ${seq.captionTracks.length + 1}`, { size: Math.round(seq.height / 18), stroke_width: 3, ...cleanStyle(a.style) })
      return { state: setItem(p, { ...seq, captionTracks: [...seq.captionTracks, ct] }), result: { trackId: id } }
    }
  }),
  defineCommand<{ sequenceId: Id; trackId: Id; style: Record<string, unknown> }>({
    id: 'caption.set_style',
    label: 'Caption Style',
    menuPath: null,
    shortcut: null,
    doc: 'Changes the look of a caption track using text_style keys.',
    params: s.object({ sequenceId: s.string('Sequence id.'), trackId: s.string('Caption track id.'), style: { type: 'object', description: 'text_style values to change.' } }),
    run: (p, a) => {
      const seq = getSequence(p, a.sequenceId)
      const ct = captionTrack(seq, a.trackId)
      return setItem(p, withTrack(seq, { ...ct, style: { ...ct.style, ...cleanStyle(a.style) } }))
    }
  }),
  defineCommand<{ sequenceId: Id; trackId?: Id; start: TimeInput; duration?: TimeInput; end?: TimeInput; text: string }>({
    id: 'caption.add',
    label: 'Add Caption',
    menuPath: null,
    shortcut: null,
    doc: 'Adds one caption. Give end or duration. Captions on a track may not overlap. Returns { cueId }.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      trackId: s.optional(s.string('Caption track, the first one when left out.')),
      start: s.time('Start.'),
      duration: s.optional(s.time('Length.')),
      end: s.optional(s.time('End.')),
      text: s.string('Caption text. \\n for a line break.')
    }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const ct = captionTrack(seq, a.trackId)
      const start = seqTime(a.start, seq.fps)
      const duration = a.duration !== undefined ? seqTime(a.duration, seq.fps) : a.end !== undefined ? seqTime(a.end, seq.fps) - start : fail('give end or duration')
      const id = ctx.newId('cue')
      return { state: setItem(p, withTrack(seq, putCue(ct, { id, start, duration, text: a.text }))), result: { cueId: id } }
    }
  }),
  defineCommand<{ cueId: Id; text?: string; start?: TimeInput; duration?: TimeInput }>({
    id: 'caption.edit',
    label: 'Edit Caption',
    menuPath: null,
    shortcut: null,
    doc: 'Changes the text or timing of a caption.',
    params: s.object({ cueId: s.string('Caption id.'), text: s.optional(s.string('Text.')), start: s.optional(s.time('Start.')), duration: s.optional(s.time('Length.')) }),
    run: (p, a) => {
      const { seq, track, cue } = findCue(p, a.cueId)
      const next = {
        ...cue,
        text: a.text ?? cue.text,
        start: a.start === undefined ? cue.start : seqTime(a.start, seq.fps),
        duration: a.duration === undefined ? cue.duration : seqTime(a.duration, seq.fps)
      }
      return setItem(p, withTrack(seq, putCue(track, next)))
    }
  }),
  defineCommand<{ cueIds: Id[] }>({
    id: 'caption.remove',
    label: 'Delete Caption',
    menuPath: null,
    shortcut: null,
    doc: 'Deletes captions.',
    params: s.object({ cueIds: s.array(s.string('Caption id.'), 'Captions.', { minItems: 1 }) }),
    run: (p, a) => {
      let next = p
      for (const id of a.cueIds) {
        const { seq, track } = findCue(next, id)
        next = setItem(next, withTrack(seq, { ...track, cues: track.cues.filter((c) => c.id !== id) }))
      }
      return next
    }
  }),
  defineCommand<{ sequenceId: Id; trackId?: Id; mediaId?: Id; maxWords?: number; maxDuration?: TimeInput; replace?: boolean }>({
    id: 'caption.from_transcript',
    label: 'Captions from Transcript',
    menuPath: ['Sequence', 'Generate Captions'],
    shortcut: null,
    doc: 'Builds captions from the transcripts of the media playing in the sequence, following every cut, trim and speed change. Makes a caption track when there is none. Returns { trackId, count }.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      trackId: s.optional(s.string('Caption track to fill.')),
      mediaId: s.optional(s.string('Only this media.')),
      maxWords: s.optional(s.integer('Words per caption, default 6.', { minimum: 1, maximum: 40 })),
      maxDuration: s.optional(s.time('Longest caption, default 3 s.')),
      replace: s.optional(s.boolean('Clear the track first, default true.'))
    }),
    run: (p, a, ctx) => {
      let seq = getSequence(p, a.sequenceId)
      let ct: CaptionTrack
      if (a.trackId || seq.captionTracks.length) ct = captionTrack(seq, a.trackId)
      else {
        ct = createCaptionTrack(ctx.newId('ctrack'), 'Captions 1', { size: Math.round(seq.height / 18), stroke_width: 3 })
        seq = { ...seq, captionTracks: [...seq.captionTracks, ct] }
      }
      const words = mapWords(p, seq, a.mediaId)
      if (!words.length) fail('no transcript words play in this sequence, set one with transcript.set')
      const maxWords = a.maxWords ?? 6
      const maxDur = a.maxDuration === undefined ? secondsToTicks(3) : rawTime(a.maxDuration, seq.fps)
      const gapBreak = secondsToTicks(0.6)
      const groups: Mapped[][] = []
      let cur: Mapped[] = []
      for (const w of words) {
        const first = cur[0]
        const last = cur[cur.length - 1]
        const breakHere =
          cur.length > 0 &&
          (cur.length >= maxWords || w.end - first.start > maxDur || w.start - last.end > gapBreak || /[.?!]$/.test(last.word.text))
        if (breakHere) {
          groups.push(cur)
          cur = []
        }
        cur.push(w)
      }
      if (cur.length) groups.push(cur)
      const kept = a.replace === false ? ct.cues : []
      const made: CaptionCue[] = []
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i]
        const start = snapToFrame(g[0].start, seq.fps, 'floor')
        const nextStart = groups[i + 1] ? snapToFrame(groups[i + 1][0].start, seq.fps, 'floor') : Infinity
        const end = Math.min(snapToFrame(g[g.length - 1].end, seq.fps, 'ceil'), nextStart)
        if (end <= start) continue
        const cue = { id: ctx.newId('cue'), start, duration: end - start, text: g.map((w) => w.word.text).join(' ') }
        if (kept.some((c) => c.start < end && c.start + c.duration > start)) continue
        made.push(cue)
      }
      const track = { ...ct, cues: [...kept, ...made].sort((x, y) => x.start - y.start) }
      return { state: setItem(p, withTrack(seq, track)), result: { trackId: ct.id, count: made.length } }
    }
  }),
  defineCommand<{ mediaId: Id; language?: string; words: { text: string; start: TimeInput; end: TimeInput; speaker?: string; confidence?: number }[] }>({
    id: 'transcript.set',
    label: 'Set Transcript',
    menuPath: null,
    shortcut: null,
    doc: 'Stores word-level transcript timing on a media item, in media time. Word ids come back in order so they can be cut later. Returns { wordIds }.',
    params: s.object({
      mediaId: s.string('Media id.'),
      language: s.optional(s.string('BCP 47 code, e.g. en.')),
      words: s.array(
        s.object({
          text: s.string('The word.'),
          start: s.time('Start in the media.'),
          end: s.time('End in the media.'),
          speaker: s.optional(s.string('Speaker label.')),
          confidence: s.optional(s.number('0..1.'))
        }),
        'Words in order.'
      )
    }),
    run: (p, a, ctx) => {
      const m = getItem(p, a.mediaId)
      if (m.kind !== 'media') fail(`${a.mediaId} is not media`)
      const fps = m.info.fps ?? p.settings.fps
      const words: TranscriptWord[] = a.words.map((w) => {
        const start = rawTime(w.start, fps)
        const end = rawTime(w.end, fps)
        if (end < start) fail(`word "${w.text}" ends before it starts`)
        return { id: ctx.newId('w'), text: w.text, start, end, speaker: w.speaker ?? null, confidence: w.confidence ?? null }
      })
      words.sort((x, y) => x.start - y.start)
      return { state: setItem(p, { ...m, transcript: { language: a.language ?? 'en', words } }), result: { wordIds: words.map((w) => w.id) } }
    }
  }),
  defineCommand<{ sequenceId: Id; wordIds: Id[]; padding?: TimeInput }>({
    id: 'transcript.cut_words',
    label: 'Cut Words',
    menuPath: null,
    shortcut: null,
    doc: 'Text-based editing: removes the parts of the sequence where the given transcript words play, closing the gaps on every track and the captions. Neighbouring cut words merge into one cut including the pause between them. Returns { cuts }: how many ranges were removed.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      wordIds: s.array(s.string('Word id.'), 'Words to cut.', { minItems: 1 }),
      padding: s.optional(s.time('Extra trimmed on each side of each cut, default 0.'))
    }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const cut = new Set(a.wordIds)
      const pad = a.padding === undefined ? 0 : rawTime(a.padding, seq.fps)
      // a cut word followed by another cut word in the same transcript swallows the pause between
      const nextCut = new Map<Id, TranscriptWord>()
      for (const it of Object.values(p.items)) {
        if (it.kind !== 'media' || !it.transcript) continue
        const ws = it.transcript.words
        for (let i = 0; i + 1 < ws.length; i++) if (cut.has(ws[i].id) && cut.has(ws[i + 1].id)) nextCut.set(ws[i].id, ws[i + 1])
      }
      const mapped = mapWords(p, seq).filter((m) => cut.has(m.word.id))
      if (!mapped.length) fail('none of those words play in this sequence')
      const byWord = new Map(mapped.map((m) => [m.word.id, m]))
      const ranges: [Tick, Tick][] = mapped.map((m) => {
        let end = m.end
        const follow = nextCut.get(m.word.id)
        const fm = follow ? byWord.get(follow.id) : undefined
        // only bridge when the next word lands right after this one on the timeline
        if (fm && fm.start >= m.end && fm.start - m.end < secondsToTicks(2)) end = fm.start
        return [snapToFrame(Math.max(0, m.start - pad), seq.fps, 'round'), snapToFrame(end + pad, seq.fps, 'round')]
      })
      const merged = mergeRanges(ranges)
      let next = seq
      for (const [from, to] of [...merged].reverse()) next = rippleDeleteRange(next, from, to, () => ctx.newId('clip'))
      return { state: setItem(p, next), result: { cuts: merged.length } }
    }
  })
]
