import type { Rational, Tick } from './time'

// the editor's document. plain JSON all the way down so it saves, clones over IPC and diffs
// by reference. every value is treated as immutable: edits copy the path they touch and share
// the rest (see ./immutable.ts)

export const SCHEMA_VERSION = 1

export type Id = string

export interface Project {
  schemaVersion: number
  id: Id
  name: string
  settings: ProjectSettings
  rootBinId: Id
  bins: Record<Id, Bin>
  items: Record<Id, ProjectItem>
}

export interface ProjectSettings {
  fps: Rational
  width: number
  height: number
  sampleRate: number
}

// bins form a tree through parentId, items point at their bin. no child arrays to keep in sync
export interface Bin {
  id: Id
  name: string
  parentId: Id | null
}

export type ProjectItem = MediaItem | SequenceItem | SubclipItem | GraphicItem

interface ItemBase {
  id: Id
  name: string
  binId: Id
}

export interface MediaProbe {
  duration: Tick
  hasVideo: boolean
  hasAudio: boolean
  // still images have video, no audio and duration 0
  isStill: boolean
  width: number
  height: number
  fps: Rational | null
  sampleRate: number
  channels: number
  videoCodec: string
  audioCodec: string
  // clockwise degrees the player should turn the picture, already folded into width and height
  rotation: number
}

export interface MediaItem extends ItemBase {
  kind: 'media'
  path: string
  // the TrendDeck media library item this came from, if any
  libraryId: string | null
  info: MediaProbe
  proxyPath: string | null
  transcript: Transcript | null
}

export interface SequenceItem extends ItemBase {
  kind: 'sequence'
  fps: Rational
  width: number
  height: number
  sampleRate: number
  // index 0 is the bottom video track, drawn first
  videoTracks: Track[]
  audioTracks: Track[]
  captionTracks: CaptionTrack[]
  markers: Marker[]
}

// a named range of another item, used like the item itself
export interface SubclipItem extends ItemBase {
  kind: 'subclip'
  sourceId: Id
  in: Tick
  out: Tick
}

// stills, titles and lower thirds. a text title is a graphic whose doc has one text layer
export interface GraphicItem extends ItemBase {
  kind: 'graphic'
  doc: ImageDoc
  // how long it lands on a timeline when dropped
  defaultDuration: Tick
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: Id
  kind: TrackKind
  name: string
  // sorted by start, never overlapping
  items: TrackItem[]
  muted: boolean
  locked: boolean
  hidden: boolean
}

export interface TrackItem {
  id: Id
  // the project item this plays: media, subclip, graphic or a nested sequence
  itemRef: Id
  // timeline position and length, in sequence ticks
  start: Tick
  duration: Tick
  // where playback begins in the referenced item's own time
  sourceIn: Tick
  // source ticks per timeline tick, 2 plays twice as fast
  speed: number
  effects: EffectInstance[]
  // a transition across the cut at this item's start
  transitionIn: Transition | null
  // video and audio from one import share a link id and move together
  linkId: Id | null
  enabled: boolean
}

// source time a timeline item ends at, exclusive
export function sourceOut(ti: TrackItem): Tick {
  return ti.sourceIn + Math.round(ti.duration * ti.speed)
}

export function itemEnd(ti: TrackItem): Tick {
  return ti.start + ti.duration
}

export interface Keyframe {
  // anchored in the referenced item's own time, so trims, splits and moves never shift it
  t: Tick
  value: number
  ease: Ease
}

export type Ease = 'linear' | 'hold' | 'ease_in' | 'ease_out' | 'ease_in_out'

export type ParamScalar = number | string | boolean

export type ParamValue = { value: ParamScalar } | { keyframes: Keyframe[] }

export interface EffectInstance {
  id: Id
  defId: string
  enabled: boolean
  params: Record<string, ParamValue>
}

export interface Transition {
  id: Id
  defId: string
  duration: Tick
  // where the transition sits relative to the cut
  alignment: 'center' | 'start' | 'end'
  params: Record<string, ParamScalar>
}

export interface Marker {
  id: Id
  at: Tick
  duration: Tick
  label: string
  color: string
}

// sequence-time captions, styled per track. ripple edits shift them with the picture
export interface CaptionTrack {
  id: Id
  name: string
  hidden: boolean
  style: Record<string, ParamScalar>
  // sorted, non-overlapping
  cues: CaptionCue[]
}

export interface CaptionCue {
  id: Id
  start: Tick
  duration: Tick
  text: string
}

// words in media time. cutting words maps them through the clips that play that media
export interface Transcript {
  language: string
  words: TranscriptWord[]
}

export interface TranscriptWord {
  id: Id
  text: string
  start: Tick
  end: Tick
  speaker: string | null
  confidence: number | null
}

// photoshop-lite, shared by stills on the timeline and standalone image documents
export interface ImageDoc {
  width: number
  height: number
  // css color, or null for transparent
  background: string | null
  // bottom to top
  layers: Layer[]
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'add' | 'difference'

export interface LayerTransform {
  // layer centre, in doc pixels from the top left
  x: number
  y: number
  scaleX: number
  scaleY: number
  // clockwise degrees
  rotation: number
}

interface LayerBase {
  id: Id
  name: string
  visible: boolean
  // 0..100
  opacity: number
  blend: BlendMode
  transform: LayerTransform
}

export interface RasterLayer extends LayerBase {
  type: 'raster'
  mediaId: Id
}

export interface TextLayer extends LayerBase {
  type: 'text'
  text: string
  // values for the text_style effect def
  style: Record<string, ParamScalar>
}

export interface ShapeLayer extends LayerBase {
  type: 'shape'
  shape: 'rect' | 'ellipse'
  width: number
  height: number
  fill: string
  stroke: string | null
  strokeWidth: number
  radius: number
}

export interface AdjustmentLayer extends LayerBase {
  type: 'adjustment'
  effect: EffectInstance
}

export type Layer = RasterLayer | TextLayer | ShapeLayer | AdjustmentLayer

export function sequenceDuration(seq: SequenceItem): Tick {
  let end = 0
  for (const tr of [...seq.videoTracks, ...seq.audioTracks]) {
    const last = tr.items[tr.items.length - 1]
    if (last) end = Math.max(end, itemEnd(last))
  }
  for (const ct of seq.captionTracks) {
    const last = ct.cues[ct.cues.length - 1]
    if (last) end = Math.max(end, last.start + last.duration)
  }
  return end
}

export function allTracks(seq: SequenceItem): Track[] {
  return [...seq.videoTracks, ...seq.audioTracks]
}
