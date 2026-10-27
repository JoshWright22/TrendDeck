import { defaultScalars } from './effects'
import {
  SCHEMA_VERSION,
  type CaptionTrack,
  type GraphicItem,
  type Id,
  type ImageDoc,
  type LayerTransform,
  type MediaItem,
  type MediaProbe,
  type Project,
  type ProjectSettings,
  type SequenceItem,
  type TextLayer,
  type Track,
  type TrackKind
} from './model'
import { FPS, secondsToTicks, type Rational } from './time'

// constructors with sensible defaults, used by commands, tests and the main process

export const SEQUENCE_PRESETS = {
  youtube_1080p: { width: 1920, height: 1080, label: 'YouTube 1080p (16:9)' },
  vertical_1080x1920: { width: 1080, height: 1920, label: 'Shorts / Reels / TikTok (9:16)' },
  square_1080: { width: 1080, height: 1080, label: 'Square (1:1)' }
} as const

export type SequencePreset = keyof typeof SEQUENCE_PRESETS

export function createProject(opts: { id: Id; name?: string; rootBinId?: Id; settings?: Partial<ProjectSettings> }): Project {
  const rootBinId = opts.rootBinId ?? `bin_root`
  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    name: opts.name ?? 'Untitled',
    settings: { fps: FPS.f30, width: 1920, height: 1080, sampleRate: 48000, ...opts.settings },
    rootBinId,
    bins: { [rootBinId]: { id: rootBinId, name: 'Project', parentId: null } },
    items: {}
  }
}

export function createTrack(id: Id, kind: TrackKind, name: string): Track {
  return { id, kind, name, items: [], muted: false, locked: false, hidden: false }
}

export function createSequence(opts: {
  id: Id
  name: string
  binId: Id
  fps: Rational
  width: number
  height: number
  sampleRate?: number
  videoTrackIds: Id[]
  audioTrackIds: Id[]
}): SequenceItem {
  return {
    kind: 'sequence',
    id: opts.id,
    name: opts.name,
    binId: opts.binId,
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    sampleRate: opts.sampleRate ?? 48000,
    videoTracks: opts.videoTrackIds.map((id, i) => createTrack(id, 'video', `V${i + 1}`)),
    audioTracks: opts.audioTrackIds.map((id, i) => createTrack(id, 'audio', `A${i + 1}`)),
    captionTracks: [],
    markers: []
  }
}

export function createMedia(opts: { id: Id; name: string; binId: Id; path: string; info: MediaProbe; libraryId?: string | null }): MediaItem {
  return {
    kind: 'media',
    id: opts.id,
    name: opts.name,
    binId: opts.binId,
    path: opts.path,
    libraryId: opts.libraryId ?? null,
    info: opts.info,
    proxyPath: null,
    transcript: null
  }
}

export function probeDefaults(partial: Partial<MediaProbe> = {}): MediaProbe {
  return {
    duration: 0,
    hasVideo: false,
    hasAudio: false,
    isStill: false,
    width: 0,
    height: 0,
    fps: null,
    sampleRate: 0,
    channels: 0,
    videoCodec: '',
    audioCodec: '',
    rotation: 0,
    ...partial
  }
}

export function centeredTransform(doc: { width: number; height: number }): LayerTransform {
  return { x: doc.width / 2, y: doc.height / 2, scaleX: 1, scaleY: 1, rotation: 0 }
}

export function createImageDoc(width: number, height: number, background: string | null = null): ImageDoc {
  return { width, height, background, layers: [] }
}

export function createTextLayer(id: Id, doc: ImageDoc, text: string, style: Record<string, string | number | boolean> = {}): TextLayer {
  return {
    id,
    type: 'text',
    name: text.slice(0, 32) || 'Text',
    visible: true,
    opacity: 100,
    blend: 'normal',
    transform: centeredTransform(doc),
    text,
    style: { ...defaultScalars('text_style'), ...style }
  }
}

export function createGraphic(opts: { id: Id; name: string; binId: Id; doc: ImageDoc; defaultDuration?: number }): GraphicItem {
  return { kind: 'graphic', id: opts.id, name: opts.name, binId: opts.binId, doc: opts.doc, defaultDuration: opts.defaultDuration ?? secondsToTicks(5) }
}

export function createCaptionTrack(id: Id, name: string, style: Record<string, string | number | boolean> = {}): CaptionTrack {
  return { id, name, hidden: false, style: { ...defaultScalars('text_style'), ...style }, cues: [] }
}

// a fresh id generator: short random base36 with a prefix, never colliding with `taken`
export function idGenerator(taken: () => Record<string, unknown> | null = () => null): (prefix: string) => Id {
  return (prefix) => {
    for (;;) {
      const id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`
      const t = taken()
      if (!t || !(id in t)) return id
    }
  }
}

// counter ids for tests and reproducible batches
export function counterIds(): (prefix: string) => Id {
  const n = new Map<string, number>()
  return (prefix) => {
    const next = (n.get(prefix) ?? 0) + 1
    n.set(prefix, next)
    return `${prefix}_${next}`
  }
}
