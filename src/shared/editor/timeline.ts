import { effectDef } from './effects'
import {
  itemEnd,
  sourceOut,
  type CaptionTrack,
  type Id,
  type Project,
  type ProjectItem,
  type SequenceItem,
  type Track,
  type TrackItem
} from './model'
import type { Tick } from './time'

// pure timeline helpers. every function returns new objects for what it changed and reuses
// the rest, so old snapshots stay valid for undo

export class EditError extends Error {}

export function fail(reason: string): never {
  throw new EditError(reason)
}

export interface ClipLocation {
  seq: SequenceItem
  track: Track
  trackIndex: number
  index: number
  clip: TrackItem
}

export function getSequence(p: Project, id: Id): SequenceItem {
  const it = p.items[id]
  if (!it) fail(`no item ${id}`)
  if (it.kind !== 'sequence') fail(`${id} is a ${it.kind}, not a sequence`)
  return it
}

export function getItem(p: Project, id: Id): ProjectItem {
  return p.items[id] ?? fail(`no item ${id}`)
}

export function findClip(p: Project, clipId: Id): ClipLocation | null {
  for (const it of Object.values(p.items)) {
    if (it.kind !== 'sequence') continue
    const found = findClipIn(it, clipId)
    if (found) return found
  }
  return null
}

export function findClipIn(seq: SequenceItem, clipId: Id): ClipLocation | null {
  const tracks = [...seq.videoTracks, ...seq.audioTracks]
  for (let ti = 0; ti < tracks.length; ti++) {
    const index = tracks[ti].items.findIndex((c) => c.id === clipId)
    if (index >= 0) return { seq, track: tracks[ti], trackIndex: ti, index, clip: tracks[ti].items[index] }
  }
  return null
}

export function getClip(p: Project, clipId: Id): ClipLocation {
  return findClip(p, clipId) ?? fail(`no clip ${clipId}`)
}

export function findTrack(seq: SequenceItem, trackId: Id): Track | null {
  return seq.videoTracks.find((t) => t.id === trackId) ?? seq.audioTracks.find((t) => t.id === trackId) ?? null
}

export function setItem(p: Project, item: ProjectItem): Project {
  return { ...p, items: { ...p.items, [item.id]: item } }
}

export function mapTracks(seq: SequenceItem, fn: (t: Track) => Track): SequenceItem {
  const mv = seq.videoTracks.map(fn)
  const ma = seq.audioTracks.map(fn)
  const same = (a: Track[], b: Track[]): boolean => a.every((t, i) => t === b[i])
  if (same(mv, seq.videoTracks) && same(ma, seq.audioTracks)) return seq
  return { ...seq, videoTracks: mv, audioTracks: ma }
}

export function replaceTrack(seq: SequenceItem, track: Track): SequenceItem {
  return mapTracks(seq, (t) => (t.id === track.id ? track : t))
}

export function linkedClips(seq: SequenceItem, clip: TrackItem): TrackItem[] {
  if (!clip.linkId) return [clip]
  const out: TrackItem[] = []
  for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.items) if (c.linkId === clip.linkId) out.push(c)
  return out
}

// how much source an item can supply from its own time zero. Infinity for stills and graphics
export function sourceLength(p: Project, itemRef: Id): Tick {
  const it = p.items[itemRef]
  if (!it) return 0
  switch (it.kind) {
    case 'media':
      return it.info.isStill ? Infinity : it.info.duration
    case 'subclip':
      return it.out - it.in
    case 'graphic':
      return Infinity
    case 'sequence': {
      let end = 0
      for (const t of [...it.videoTracks, ...it.audioTracks]) {
        const last = t.items[t.items.length - 1]
        if (last) end = Math.max(end, itemEnd(last))
      }
      return end
    }
  }
}

function sortItems(items: TrackItem[]): TrackItem[] {
  return [...items].sort((a, b) => a.start - b.start)
}

// cuts a clip at timeline time `at`. keyframes stay in source time so both halves keep them
export function splitClip(clip: TrackItem, at: Tick, rightId: Id, newId: () => Id): [TrackItem, TrackItem] {
  if (at <= clip.start || at >= itemEnd(clip)) fail('split point must be inside the clip')
  const leftDur = at - clip.start
  const left: TrackItem = { ...clip, duration: leftDur, effects: clip.effects.map((fx) => dropFade(fx, 'fade_out')) }
  const right: TrackItem = {
    ...clip,
    id: rightId,
    start: at,
    duration: clip.duration - leftDur,
    sourceIn: clip.sourceIn + Math.round(leftDur * clip.speed),
    transitionIn: null,
    effects: clip.effects.map((fx) => ({ ...dropFade(fx, 'fade_in'), id: newId() }))
  }
  return [left, right]
}

// a split keeps the fade in on the left half and the fade out on the right
function dropFade(fx: TrackItem['effects'][number], key: 'fade_in' | 'fade_out'): TrackItem['effects'][number] {
  if (fx.defId !== 'fade' || !effectDef('fade')) return fx
  const v = fx.params[key]
  if (!v || ('value' in v && !v.value)) return fx
  return { ...fx, params: { ...fx.params, [key]: { value: 0 } } }
}

// trims the clip so only the part inside [from, to) of the timeline remains
export function cropClip(clip: TrackItem, from: Tick, to: Tick): TrackItem {
  const s = Math.max(clip.start, from)
  const e = Math.min(itemEnd(clip), to)
  if (e <= s) fail('crop leaves nothing')
  if (s === clip.start && e === itemEnd(clip)) return clip
  return {
    ...clip,
    start: s,
    duration: e - s,
    sourceIn: clip.sourceIn + Math.round((s - clip.start) * clip.speed),
    transitionIn: s === clip.start ? clip.transitionIn : null
  }
}

// empties [start, end) on a track, cutting clips that straddle the edges
export function clearRange(track: Track, start: Tick, end: Tick, newId: () => Id): Track {
  if (end <= start) return track
  let changed = false
  const out: TrackItem[] = []
  for (const c of track.items) {
    const cEnd = itemEnd(c)
    if (cEnd <= start || c.start >= end) {
      out.push(c)
      continue
    }
    changed = true
    if (c.start < start) out.push(cropClip(c, c.start, start))
    if (cEnd > end) {
      const right = cropClip(c, end, cEnd)
      out.push(c.start < start ? { ...right, id: newId(), effects: right.effects.map((fx) => ({ ...fx, id: newId() })) } : right)
    }
  }
  return changed ? { ...track, items: sortItems(out) } : track
}

// moves every clip starting at or after `at` by delta
export function shiftFrom(track: Track, at: Tick, delta: Tick): Track {
  if (delta === 0) return track
  let changed = false
  const items = track.items.map((c) => {
    if (c.start < at) return c
    changed = true
    return { ...c, start: c.start + delta }
  })
  return changed ? { ...track, items } : track
}

export function shiftCaptions(ct: CaptionTrack, at: Tick, delta: Tick): CaptionTrack {
  if (delta === 0) return ct
  return { ...ct, cues: ct.cues.map((c) => (c.start >= at ? { ...c, start: c.start + delta } : c)) }
}

export type PlaceMode = 'overwrite' | 'insert' | 'strict'

// puts a clip on a track. overwrite clears what's under it, insert pushes later clips right,
// strict refuses to touch anything
export function placeClip(track: Track, clip: TrackItem, mode: PlaceMode, newId: () => Id): Track {
  if (clip.duration <= 0) fail('clip length must be positive')
  if (clip.start < 0) fail('clip would start before zero')
  let t = track
  if (mode === 'overwrite') t = clearRange(t, clip.start, itemEnd(clip), newId)
  else if (mode === 'insert') {
    const straddle = t.items.find((c) => c.start < clip.start && itemEnd(c) > clip.start)
    if (straddle) {
      const [l, r] = splitClip(straddle, clip.start, newId(), newId)
      t = { ...t, items: t.items.flatMap((c) => (c === straddle ? [l, r] : [c])) }
    }
    t = shiftFrom(t, clip.start, clip.duration)
  } else {
    const hit = t.items.find((c) => c.start < itemEnd(clip) && itemEnd(c) > clip.start)
    if (hit) fail(`clip would overlap ${hit.id} on track ${track.name}`)
  }
  return { ...t, items: sortItems([...t.items, clip]) }
}

export function removeClip(track: Track, clipId: Id): Track {
  const items = track.items.filter((c) => c.id !== clipId)
  return items.length === track.items.length ? track : { ...track, items }
}

export function replaceClip(track: Track, clip: TrackItem): Track {
  return { ...track, items: sortItems(track.items.map((c) => (c.id === clip.id ? clip : c))) }
}

// removes [start, end) from the given tracks (all of them when omitted) and closes the gap
export function rippleDeleteRange(
  seq: SequenceItem,
  start: Tick,
  end: Tick,
  newId: () => Id,
  trackIds?: Set<Id>
): SequenceItem {
  if (end <= start) return seq
  const delta = start - end
  const all = !trackIds
  const next = mapTracks(seq, (t) => {
    if (!all && !trackIds.has(t.id)) return t
    if (t.locked) fail(`track ${t.name} is locked`)
    return shiftFrom(clearRange(t, start, end, newId), end, delta)
  })
  if (!all) return next
  return {
    ...next,
    captionTracks: next.captionTracks.map((ct) => {
      const kept = ct.cues.flatMap((c) => {
        const cEnd = c.start + c.duration
        if (cEnd <= start || c.start >= end) return [c]
        // a cue that loses its middle keeps the part before the cut
        const s = c.start < start ? c.start : end
        const e = c.start < start ? Math.min(cEnd, start) : cEnd
        return e > s ? [{ ...c, start: s, duration: e - s }] : []
      })
      return shiftCaptions({ ...ct, cues: kept }, end, delta)
    }),
    markers: next.markers.flatMap((m) => {
      if (m.at >= start && m.at < end) return []
      return [m.at >= end ? { ...m, at: m.at + delta } : m]
    })
  }
}

// throws if a track breaks its invariants. cheap enough to run after every edit in dev and tests
export function checkTrack(t: Track): void {
  let prevEnd = -Infinity
  for (const c of t.items) {
    if (!(c.duration > 0)) fail(`clip ${c.id} has non-positive length`)
    if (c.start < 0) fail(`clip ${c.id} starts before zero`)
    if (c.start < prevEnd) fail(`clip ${c.id} overlaps the clip before it on ${t.name}`)
    if (!Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.duration) || !Number.isSafeInteger(c.sourceIn)) {
      fail(`clip ${c.id} has non-integer ticks`)
    }
    prevEnd = itemEnd(c)
  }
}

export function checkProject(p: Project): void {
  for (const it of Object.values(p.items)) {
    if (it.kind !== 'sequence') continue
    for (const t of [...it.videoTracks, ...it.audioTracks]) {
      checkTrack(t)
      for (const c of t.items) {
        if (!p.items[c.itemRef]) fail(`clip ${c.id} points at missing item ${c.itemRef}`)
        const len = sourceLength(p, c.itemRef)
        if (c.sourceIn < 0 || sourceOut(c) > len + 1) fail(`clip ${c.id} plays past its source`)
      }
    }
    for (const ct of it.captionTracks) {
      let prev = -Infinity
      for (const c of ct.cues) {
        if (c.start < prev) fail(`caption ${c.id} overlaps the one before it`)
        prev = c.start + c.duration
      }
    }
  }
}
