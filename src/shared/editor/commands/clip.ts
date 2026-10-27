import { defineCommand, rawTime, seqTime, type CommandContext, type CommandSpec } from '../command'
import { effectDef } from '../effects'
import { createTrack } from '../factory'
import { itemEnd, sequenceDuration, sourceOut, type Id, type Project, type SequenceItem, type Track, type TrackItem, type TrackKind } from '../model'
import { s } from '../schema'
import { secondsToTicks, snapToFrame, type Tick, type TimeInput } from '../time'
import {
  fail,
  findTrack,
  getClip,
  getItem,
  getSequence,
  linkedClips,
  mapTracks,
  placeClip,
  removeClip,
  replaceClip,
  rippleDeleteRange,
  setItem,
  shiftFrom,
  sourceLength,
  splitClip,
  type PlaceMode
} from '../timeline'

const modeSchema = s.enum(
  ['overwrite', 'insert', 'strict'],
  'overwrite replaces what is underneath, insert pushes later clips right, strict fails on any overlap.'
)

function trackOf(seq: SequenceItem, clipId: Id): Track {
  for (const t of [...seq.videoTracks, ...seq.audioTracks]) if (t.items.some((c) => c.id === clipId)) return t
  return fail(`no clip ${clipId}`)
}

function unlocked(t: Track): Track {
  if (t.locked) fail(`track ${t.name} is locked`)
  return t
}

// the clip plus everything linked to it, unless the caller asked to edit it alone
function group(seq: SequenceItem, clip: TrackItem, linked: boolean | undefined): TrackItem[] {
  return linked === false ? [clip] : linkedClips(seq, clip)
}

function idsOf(ctx: CommandContext): () => Id {
  return () => ctx.newId('clip')
}

// what kind of track an item can sit on
function playsOn(p: Project, itemRef: Id): { video: boolean; audio: boolean } {
  const it = getItem(p, itemRef)
  switch (it.kind) {
    case 'media':
      return { video: it.info.hasVideo, audio: it.info.hasAudio }
    case 'subclip': {
      const src = getItem(p, it.sourceId)
      return src.kind === 'media' ? { video: src.info.hasVideo, audio: src.info.hasAudio } : { video: true, audio: true }
    }
    case 'graphic':
      return { video: true, audio: false }
    case 'sequence': {
      const hasA = it.audioTracks.some((t) => t.items.length > 0)
      return { video: true, audio: hasA }
    }
  }
}

function sourceFps(p: Project, itemRef: Id, fallback: SequenceItem['fps']): SequenceItem['fps'] {
  const it = p.items[itemRef]
  if (it?.kind === 'media' && it.info.fps) return it.info.fps
  if (it?.kind === 'sequence') return it.fps
  return fallback
}

function pickTrack(seq: SequenceItem, kind: TrackKind, trackId: Id | undefined): Track | null {
  if (trackId) {
    const t = findTrack(seq, trackId) ?? fail(`no track ${trackId}`)
    if (t.kind !== kind) fail(`${t.name} is a ${t.kind} track`)
    return t
  }
  const list = kind === 'video' ? seq.videoTracks : seq.audioTracks
  return list.find((t) => !t.locked) ?? null
}

function addTrackTo(seq: SequenceItem, kind: TrackKind, id: Id): [SequenceItem, Track] {
  const list = kind === 'video' ? seq.videoTracks : seq.audioTracks
  const t = createTrack(id, kind, `${kind === 'video' ? 'V' : 'A'}${list.length + 1}`)
  return [kind === 'video' ? { ...seq, videoTracks: [...list, t] } : { ...seq, audioTracks: [...list, t] }, t]
}

// checks a clip's source range still fits its item
function checkSource(p: Project, c: TrackItem): void {
  if (c.sourceIn < 0) fail('trim runs past the start of the source')
  if (sourceOut(c) > sourceLength(p, c.itemRef)) fail('trim runs past the end of the source')
}

function neighbours(t: Track, clip: TrackItem): { prev: TrackItem | null; next: TrackItem | null } {
  const i = t.items.findIndex((c) => c.id === clip.id)
  return { prev: t.items[i - 1] ?? null, next: t.items[i + 1] ?? null }
}

export const clipCommands: CommandSpec[] = [
  defineCommand<{ sequenceId: Id; kind: TrackKind; name?: string; index?: number }>({
    id: 'track.add',
    label: 'Add Track',
    menuPath: ['Sequence', 'Add Track'],
    shortcut: null,
    doc: 'Adds a video or audio track. Video track 0 is the bottom layer. Returns { trackId }.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      kind: s.enum(['video', 'audio'], 'Track type.'),
      name: s.optional(s.string('Name, V3/A3 style when left out.')),
      index: s.optional(s.integer('Position among tracks of that kind, top/last when left out.', { minimum: 0 }))
    }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const key = a.kind === 'video' ? 'videoTracks' : 'audioTracks'
      const list = [...seq[key]]
      const id = ctx.newId('track')
      const t = createTrack(id, a.kind, a.name ?? `${a.kind === 'video' ? 'V' : 'A'}${list.length + 1}`)
      list.splice(Math.min(a.index ?? list.length, list.length), 0, t)
      return { state: setItem(p, { ...seq, [key]: list }), result: { trackId: id } }
    }
  }),
  defineCommand<{ sequenceId: Id; trackId: Id; force?: boolean }>({
    id: 'track.remove',
    label: 'Delete Track',
    menuPath: ['Sequence', 'Delete Track'],
    shortcut: null,
    doc: 'Deletes a track. Refuses if it has clips unless force is true.',
    params: s.object({ sequenceId: s.string('Sequence id.'), trackId: s.string('Track id.'), force: s.optional(s.boolean('Delete its clips too.')) }),
    run: (p, a) => {
      const seq = getSequence(p, a.sequenceId)
      const t = findTrack(seq, a.trackId) ?? fail(`no track ${a.trackId}`)
      if (t.items.length && !a.force) fail(`${t.name} still has ${t.items.length} clip(s)`)
      return setItem(p, {
        ...seq,
        videoTracks: seq.videoTracks.filter((x) => x.id !== t.id),
        audioTracks: seq.audioTracks.filter((x) => x.id !== t.id)
      })
    }
  }),
  defineCommand<{ sequenceId: Id; trackId: Id; name?: string; muted?: boolean; locked?: boolean; hidden?: boolean }>({
    id: 'track.set',
    label: 'Track Options',
    menuPath: null,
    shortcut: null,
    doc: 'Renames, mutes, locks or hides a track. Locked tracks refuse edits.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      trackId: s.string('Track id.'),
      name: s.optional(s.string('Name.')),
      muted: s.optional(s.boolean('Silence it.')),
      locked: s.optional(s.boolean('Block edits.')),
      hidden: s.optional(s.boolean('Hide its picture.'))
    }),
    run: (p, a) => {
      const seq = getSequence(p, a.sequenceId)
      const t = findTrack(seq, a.trackId) ?? fail(`no track ${a.trackId}`)
      const { sequenceId: _s, trackId: _t, ...rest } = a
      void _s
      void _t
      return setItem(p, mapTracks(seq, (x) => (x.id === t.id ? { ...x, ...rest } : x)))
    }
  }),
  defineCommand<{
    sequenceId: Id
    itemId: Id
    at?: TimeInput
    sourceIn?: TimeInput
    duration?: TimeInput
    trackId?: Id
    audioTrackId?: Id
    mode?: PlaceMode
    video?: boolean
    audio?: boolean
  }>({
    id: 'clip.add',
    label: 'Add to Timeline',
    menuPath: ['Clip', 'Add to Timeline'],
    shortcut: null,
    doc: 'Places a project item on a sequence. Media with picture and sound lands as a linked video and audio pair. Defaults: at = end of the sequence, sourceIn = 0, duration = the rest of the source (5 s for stills, the graphic default for titles), first unlocked tracks. Returns { clipIds }.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      itemId: s.string('Media, subclip, graphic or sequence to place.'),
      at: s.optional(s.time('Timeline position.')),
      sourceIn: s.optional(s.time('Where in the source to start.')),
      duration: s.optional(s.time('Length on the timeline.')),
      trackId: s.optional(s.string('Video track (or audio track for audio-only items).')),
      audioTrackId: s.optional(s.string('Audio track for the linked audio.')),
      mode: s.optional(modeSchema),
      video: s.optional(s.boolean('Include the picture, default true.')),
      audio: s.optional(s.boolean('Include the sound, default true.'))
    }),
    run: (p, a, ctx) => {
      let seq = getSequence(p, a.sequenceId)
      if (a.itemId === seq.id) fail("a sequence can't contain itself")
      const item = getItem(p, a.itemId)
      const plays = playsOn(p, a.itemId)
      const wantV = plays.video && a.video !== false
      const wantA = plays.audio && a.audio !== false
      if (!wantV && !wantA) fail('nothing to place')
      const srcFps = sourceFps(p, a.itemId, seq.fps)
      let sourceIn = a.sourceIn === undefined ? 0 : rawTime(a.sourceIn, srcFps)
      if (item.kind === 'subclip') sourceIn = Math.max(0, sourceIn)
      const len = sourceLength(p, a.itemId)
      let duration: Tick
      if (a.duration !== undefined) duration = seqTime(a.duration, seq.fps)
      else if (item.kind === 'graphic') duration = item.defaultDuration
      else if (len === Infinity) duration = secondsToTicks(5)
      else duration = snapToFrame(len - sourceIn, seq.fps, 'floor')
      if (duration <= 0) fail('nothing left of the source after sourceIn')
      const at = a.at === undefined ? sequenceDuration(seq) : seqTime(a.at, seq.fps)
      const mode = a.mode ?? 'overwrite'
      const linkId = wantV && wantA ? ctx.newId('link') : null
      const clipIds: Id[] = []
      const place = (kind: TrackKind, trackId: Id | undefined): void => {
        let t = pickTrack(seq, kind, trackId)
        if (!t) [seq, t] = addTrackTo(seq, kind, ctx.newId('track'))
        unlocked(t)
        const clip: TrackItem = {
          id: ctx.newId('clip'),
          itemRef: a.itemId,
          start: at,
          duration,
          sourceIn,
          speed: 1,
          effects: [],
          transitionIn: null,
          linkId,
          enabled: true
        }
        checkSource(p, clip)
        seq = mapTracks(seq, (x) => (x.id === t.id ? placeClip(x, clip, mode, idsOf(ctx)) : x))
        clipIds.push(clip.id)
      }
      if (wantV) place('video', a.trackId)
      if (wantA) place('audio', wantV ? a.audioTrackId : (a.audioTrackId ?? a.trackId))
      return { state: setItem(p, seq), result: { clipIds } }
    }
  }),
  defineCommand<{ clipId: Id; to?: TimeInput; by?: TimeInput; trackId?: Id; mode?: PlaceMode; linked?: boolean }>({
    id: 'clip.move',
    label: 'Move Clip',
    menuPath: null,
    shortcut: null,
    doc: 'Moves a clip (and its linked clips) to a new start time and/or track. Give `to` (new start) or `by` (offset, may be negative). Default mode overwrite.',
    params: s.object({
      clipId: s.string('Clip id.'),
      to: s.optional(s.time('New start.')),
      by: s.optional(s.time('Offset from the current start.')),
      trackId: s.optional(s.string('Target track of the same kind, for this clip only.')),
      mode: s.optional(modeSchema),
      linked: s.optional(s.boolean('Move linked clips too, default true.'))
    }),
    run: (p, a, ctx) => {
      const loc = getClip(p, a.clipId)
      let seq = loc.seq
      const delta = a.to !== undefined ? seqTime(a.to, seq.fps) - loc.clip.start : a.by !== undefined ? seqTime(a.by, seq.fps) : 0
      const moving = group(seq, loc.clip, a.linked)
      const dest = new Map<Id, Id>()
      for (const c of moving) {
        const from = unlocked(trackOf(seq, c.id))
        let to = from
        if (c.id === loc.clip.id && a.trackId) {
          to = findTrack(seq, a.trackId) ?? fail(`no track ${a.trackId}`)
          if (to.kind !== from.kind) fail(`can't move a ${from.kind} clip to a ${to.kind} track`)
          unlocked(to)
        }
        dest.set(c.id, to.id)
      }
      if (delta === 0 && [...dest].every(([cid, tid]) => trackOf(seq, cid).id === tid)) return p
      for (const c of moving) seq = mapTracks(seq, (t) => removeClip(t, c.id))
      for (const c of moving) {
        const moved = { ...c, start: c.start + delta }
        if (moved.start < 0) fail('clip would start before zero')
        seq = mapTracks(seq, (t) => (t.id === dest.get(c.id) ? placeClip(t, moved, a.mode ?? 'overwrite', idsOf(ctx)) : t))
      }
      return setItem(p, seq)
    }
  }),
  defineCommand<{ clipId: Id; edge: 'start' | 'end'; to?: TimeInput; by?: TimeInput; ripple?: boolean; linked?: boolean }>({
    id: 'clip.trim',
    label: 'Trim Clip',
    menuPath: null,
    shortcut: null,
    doc: 'Moves the start or end edge of a clip. Give `to` (new edge time on the timeline) or `by` (offset, positive moves the edge right). Without ripple the clip may not grow into a neighbour; with ripple the clips after it on the same tracks shift to keep the cut tight. Source keyframes never move.',
    params: s.object({
      clipId: s.string('Clip id.'),
      edge: s.enum(['start', 'end'], 'Which edge.'),
      to: s.optional(s.time('New edge time.')),
      by: s.optional(s.time('Edge offset.')),
      ripple: s.optional(s.boolean('Shift later clips, default false.')),
      linked: s.optional(s.boolean('Trim linked clips too, default true.'))
    }),
    run: (p, a) => {
      const loc = getClip(p, a.clipId)
      let seq = loc.seq
      const edgeAt = a.edge === 'start' ? loc.clip.start : itemEnd(loc.clip)
      const delta = a.to !== undefined ? seqTime(a.to, seq.fps) - edgeAt : a.by !== undefined ? seqTime(a.by, seq.fps) : 0
      if (delta === 0) return p
      for (const c of group(seq, loc.clip, a.linked)) {
        const t = unlocked(trackOf(seq, c.id))
        let next: TrackItem
        if (a.edge === 'start') {
          const srcDelta = Math.round(delta * c.speed)
          next = a.ripple
            ? { ...c, sourceIn: c.sourceIn + srcDelta, duration: c.duration - delta }
            : { ...c, start: c.start + delta, sourceIn: c.sourceIn + srcDelta, duration: c.duration - delta }
        } else next = { ...c, duration: c.duration + delta }
        if (next.duration <= 0) fail('trim would leave nothing of the clip')
        checkSource(p, next)
        let tr = t
        if (a.ripple) {
          // later clips follow the clip's end: it moved by -delta for a head trim, +delta for a tail
          const shift = a.edge === 'start' ? -delta : delta
          tr = shiftFrom(tr, itemEnd(c), shift)
        } else {
          const { prev, next: after } = neighbours(t, c)
          if (prev && next.start < itemEnd(prev)) fail(`trim would overlap ${prev.id}`)
          if (after && itemEnd(next) > after.start) fail(`trim would overlap ${after.id}`)
        }
        seq = mapTracks(seq, (x) => (x.id === t.id ? replaceClip(tr, next) : x))
      }
      return setItem(p, seq)
    }
  }),
  defineCommand<{ clipId?: Id; sequenceId?: Id; at: TimeInput; linked?: boolean }>({
    id: 'clip.split',
    label: 'Split',
    menuPath: ['Clip', 'Split'],
    shortcut: 'CmdOrCtrl+K',
    doc: 'Cuts a clip in two at a timeline time (with its linked clips). Without clipId it cuts every clip on unlocked tracks of the sequence under the time. Keyframes stay where they were in the source. Returns { newClipIds }: the right-hand halves.',
    params: s.object({
      clipId: s.optional(s.string('Clip to cut.')),
      sequenceId: s.optional(s.string('Sequence, when cutting everything under `at`.')),
      at: s.time('Cut time on the timeline.'),
      linked: s.optional(s.boolean('Cut linked clips too, default true.'))
    }),
    run: (p, a, ctx) => {
      let seq: SequenceItem
      let targets: TrackItem[]
      let at: Tick
      if (a.clipId) {
        const loc = getClip(p, a.clipId)
        seq = loc.seq
        at = seqTime(a.at, seq.fps)
        targets = group(seq, loc.clip, a.linked).filter((c) => c.start < at && itemEnd(c) > at)
        if (!targets.some((c) => c.id === a.clipId)) fail('the cut time is not inside the clip')
      } else if (a.sequenceId) {
        seq = getSequence(p, a.sequenceId)
        at = seqTime(a.at, seq.fps)
        targets = [...seq.videoTracks, ...seq.audioTracks].filter((t) => !t.locked).flatMap((t) => t.items.filter((c) => c.start < at && itemEnd(c) > at))
        if (!targets.length) fail('no clip under that time')
      } else return fail('give clipId or sequenceId')
      const newClipIds: Id[] = []
      for (const c of targets) {
        const t = unlocked(trackOf(seq, c.id))
        const [l, r] = splitClip(c, at, ctx.newId('clip'), () => ctx.newId('fx'))
        newClipIds.push(r.id)
        seq = mapTracks(seq, (x) => (x.id === t.id ? { ...x, items: x.items.flatMap((y) => (y.id === c.id ? [l, r] : [y])) } : x))
      }
      // the right halves of a linked pair stay linked to each other
      const pairs = new Map<Id, Id>()
      seq = mapTracks(seq, (t) => {
        let changed = false
        const items = t.items.map((c) => {
          if (!newClipIds.includes(c.id) || !c.linkId) return c
          if (!pairs.has(c.linkId)) pairs.set(c.linkId, ctx.newId('link'))
          changed = true
          return { ...c, linkId: pairs.get(c.linkId)! }
        })
        return changed ? { ...t, items } : t
      })
      return { state: setItem(p, seq), result: { newClipIds } }
    }
  }),
  defineCommand<{ clipIds: Id[]; linked?: boolean }>({
    id: 'clip.delete',
    label: 'Delete',
    menuPath: ['Edit', 'Delete'],
    shortcut: 'Delete',
    doc: 'Removes clips and leaves a gap (lift).',
    params: s.object({ clipIds: s.array(s.string('Clip id.'), 'Clips.', { minItems: 1 }), linked: s.optional(s.boolean('Delete linked clips too, default true.')) }),
    run: (p, a) => {
      let next = p
      for (const id of a.clipIds) {
        const loc = getClip(next, id)
        let seq = loc.seq
        for (const c of group(seq, loc.clip, a.linked)) {
          unlocked(trackOf(seq, c.id))
          seq = mapTracks(seq, (t) => removeClip(t, c.id))
        }
        next = setItem(next, seq)
      }
      return next
    }
  }),
  defineCommand<{ clipIds: Id[]; linked?: boolean; allTracks?: boolean }>({
    id: 'clip.ripple_delete',
    label: 'Ripple Delete',
    menuPath: ['Edit', 'Ripple Delete'],
    shortcut: 'Shift+Delete',
    doc: 'Removes clips and closes the gap. With allTracks (default true) the same time range is cut from every track and the captions so picture, sound and captions stay in sync; with allTracks false only the clips own tracks close up.',
    params: s.object({
      clipIds: s.array(s.string('Clip id.'), 'Clips.', { minItems: 1 }),
      linked: s.optional(s.boolean('Include linked clips, default true.')),
      allTracks: s.optional(s.boolean('Cut the range from every track, default true.'))
    }),
    run: (p, a, ctx) => {
      const first = getClip(p, a.clipIds[0])
      let seq = first.seq
      const clips: TrackItem[] = []
      for (const id of a.clipIds) {
        const loc = getClip(p, id)
        if (loc.seq.id !== seq.id) fail('ripple delete works on one sequence at a time')
        for (const c of group(seq, loc.clip, a.linked)) if (!clips.some((x) => x.id === c.id)) clips.push(c)
      }
      if (a.allTracks === false) {
        const byTrack = clips.map((c) => ({ c, t: unlocked(trackOf(seq, c.id)) })).sort((x, y) => y.c.start - x.c.start)
        for (const { c, t } of byTrack) seq = rippleDeleteRange(seq, c.start, itemEnd(c), idsOf(ctx), new Set([t.id]))
      } else {
        for (const [s0, e0] of mergeRanges(clips.map((c) => [c.start, itemEnd(c)])).reverse()) seq = rippleDeleteRange(seq, s0, e0, idsOf(ctx))
      }
      return setItem(p, seq)
    }
  }),
  defineCommand<{ sequenceId: Id; from: TimeInput; to: TimeInput; trackIds?: Id[] }>({
    id: 'range.ripple_delete',
    label: 'Ripple Delete Range',
    menuPath: ['Sequence', 'Ripple Delete In to Out'],
    shortcut: null,
    doc: 'Cuts a time range out of the sequence and closes the gap, on every track and caption track unless trackIds limits it.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      from: s.time('Range start.'),
      to: s.time('Range end.'),
      trackIds: s.optional(s.array(s.string('Track id.'), 'Only these tracks.'))
    }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const from = seqTime(a.from, seq.fps)
      const to = seqTime(a.to, seq.fps)
      if (to <= from) fail('range is empty')
      return setItem(p, rippleDeleteRange(seq, from, to, idsOf(ctx), a.trackIds ? new Set(a.trackIds) : undefined))
    }
  }),
  defineCommand<{ clipId: Id; by: TimeInput; linked?: boolean }>({
    id: 'clip.slip',
    label: 'Slip Clip',
    menuPath: null,
    shortcut: null,
    doc: 'Shifts which part of the source plays without moving the clip on the timeline. Positive shows later source.',
    params: s.object({ clipId: s.string('Clip id.'), by: s.time('Source offset.'), linked: s.optional(s.boolean('Slip linked clips too, default true.')) }),
    run: (p, a) => {
      const loc = getClip(p, a.clipId)
      let seq = loc.seq
      const by = rawTime(a.by, sourceFps(p, loc.clip.itemRef, seq.fps))
      for (const c of group(seq, loc.clip, a.linked)) {
        unlocked(trackOf(seq, c.id))
        const next = { ...c, sourceIn: c.sourceIn + by }
        checkSource(p, next)
        seq = mapTracks(seq, (t) => (t.items.some((x) => x.id === c.id) ? replaceClip(t, next) : t))
      }
      return setItem(p, seq)
    }
  }),
  defineCommand<{ clipId: Id; speed: number; ripple?: boolean; linked?: boolean }>({
    id: 'clip.set_speed',
    label: 'Speed',
    menuPath: ['Clip', 'Speed'],
    shortcut: 'CmdOrCtrl+R',
    doc: 'Changes playback rate, keeping the start and the same stretch of source; the clip gets shorter or longer. Without ripple it may not grow into the next clip.',
    params: s.object({
      clipId: s.string('Clip id.'),
      speed: s.number('Rate, 1 normal. Range 0.1 to 16.', { minimum: 0.1, maximum: 16 }),
      ripple: s.optional(s.boolean('Shift later clips, default false.')),
      linked: s.optional(s.boolean('Change linked clips too, default true.'))
    }),
    run: (p, a) => {
      if (!effectDef('speed')) fail('speed missing')
      const loc = getClip(p, a.clipId)
      let seq = loc.seq
      for (const c of group(seq, loc.clip, a.linked)) {
        const t = unlocked(trackOf(seq, c.id))
        const srcLen = sourceOut(c) - c.sourceIn
        const duration = Math.max(snapToFrame(Math.round(srcLen / a.speed), seq.fps, 'floor'), snapToFrame(1, seq.fps, 'ceil'))
        const next = { ...c, speed: a.speed, duration }
        checkSource(p, next)
        let tr = t
        if (a.ripple) tr = shiftFrom(tr, itemEnd(c), duration - c.duration)
        else {
          const { next: after } = neighbours(t, c)
          if (after && itemEnd(next) > after.start) fail(`slower speed would overlap ${after.id}, use ripple`)
        }
        seq = mapTracks(seq, (x) => (x.id === t.id ? replaceClip(tr, next) : x))
      }
      return setItem(p, seq)
    }
  }),
  defineCommand<{ clipIds: Id[]; enabled: boolean }>({
    id: 'clip.set_enabled',
    label: 'Enable Clip',
    menuPath: ['Clip', 'Enable'],
    shortcut: 'Shift+E',
    doc: 'Turns clips off or on without removing them.',
    params: s.object({ clipIds: s.array(s.string('Clip id.'), 'Clips.', { minItems: 1 }), enabled: s.boolean('On or off.') }),
    run: (p, a) => {
      let next = p
      for (const id of a.clipIds) {
        const loc = getClip(next, id)
        next = setItem(next, mapTracks(loc.seq, (t) => (t.id === loc.track.id ? replaceClip(t, { ...loc.clip, enabled: a.enabled }) : t)))
      }
      return next
    }
  }),
  defineCommand<{ clipIds: Id[] }>({
    id: 'clip.link',
    label: 'Link',
    menuPath: ['Clip', 'Link'],
    shortcut: null,
    doc: 'Links clips in one sequence so they move, trim and delete together. Fewer than two clips unlinks them.',
    params: s.object({ clipIds: s.array(s.string('Clip id.'), 'Clips to link, or a single clip to unlink.', { minItems: 1 }) }),
    run: (p, a, ctx) => {
      const seq = getClip(p, a.clipIds[0]).seq
      for (const id of a.clipIds) if (getClip(p, id).seq.id !== seq.id) fail('linked clips must share a sequence')
      const linkId = a.clipIds.length > 1 ? ctx.newId('link') : null
      const set = new Set(a.clipIds)
      return setItem(p, mapTracks(seq, (t) => (t.items.some((c) => set.has(c.id)) ? { ...t, items: t.items.map((c) => (set.has(c.id) ? { ...c, linkId } : c)) } : t)))
    }
  })
]

export function mergeRanges(ranges: [Tick, Tick][]): [Tick, Tick][] {
  const sorted = [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: [Tick, Tick][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}
