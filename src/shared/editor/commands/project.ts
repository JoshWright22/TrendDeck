import { defineCommand, rawTime, seqTime, type CommandSpec } from '../command'
import {
  createGraphic,
  createImageDoc,
  createMedia,
  createSequence,
  createTextLayer,
  probeDefaults,
  SEQUENCE_PRESETS,
  type SequencePreset
} from '../factory'
import type { Id, MediaProbe, Project, ProjectItem } from '../model'
import { s, type JsonSchema } from '../schema'
import { fail, getItem, getSequence, setItem } from '../timeline'
import { FPS, isSupportedFps, secondsToTicks, type Rational, type TimeInput } from '../time'

const fpsSchema: JsonSchema = {
  description: 'Frame rate: 24, 25, 30, 60, 23.976, 29.97, 59.94, "30000/1001" or {num, den}.',
  anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'object', properties: { num: { type: 'integer' }, den: { type: 'integer' } } }]
}

export function parseFps(v: unknown): Rational {
  let r: Rational | null = null
  if (typeof v === 'number') {
    const known: [number, Rational][] = [
      [23.976, FPS.f23_976],
      [29.97, FPS.f29_97],
      [59.94, FPS.f59_94]
    ]
    const hit = known.find(([k]) => Math.abs(k - v) < 0.01)
    r = hit ? hit[1] : Number.isInteger(v) ? { num: v, den: 1 } : null
  } else if (typeof v === 'string') {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v.trim())
    r = m ? { num: Number(m[1]), den: Number(m[2]) } : parseFps(Number(v))
  } else if (v && typeof v === 'object' && 'num' in v && 'den' in v) {
    r = { num: Number((v as Rational).num), den: Number((v as Rational).den) }
  }
  if (!r || !isSupportedFps(r)) fail(`unsupported frame rate ${JSON.stringify(v)}`)
  return r
}

function binOrRoot(p: Project, binId: Id | undefined): Id {
  if (!binId) return p.rootBinId
  if (!p.bins[binId]) fail(`no bin ${binId}`)
  return binId
}

// every place an item is used: clips on timelines, subclips, raster layers
export function usagesOf(p: Project, id: Id): string[] {
  const out: string[] = []
  for (const it of Object.values(p.items)) {
    if (it.kind === 'sequence') {
      for (const t of [...it.videoTracks, ...it.audioTracks]) for (const c of t.items) if (c.itemRef === id) out.push(`${it.name}/${t.name}/${c.id}`)
    } else if (it.kind === 'subclip' && it.sourceId === id) out.push(`subclip ${it.name}`)
    else if (it.kind === 'graphic') for (const l of it.doc.layers) if (l.type === 'raster' && l.mediaId === id) out.push(`graphic ${it.name}`)
  }
  return out
}

const probeSchema = s.object(
  {
    duration: s.optional(s.time('Media length.')),
    hasVideo: s.optional(s.boolean('Has a picture.')),
    hasAudio: s.optional(s.boolean('Has sound.')),
    isStill: s.optional(s.boolean('A still image.')),
    width: s.optional(s.integer('Picture width.')),
    height: s.optional(s.integer('Picture height.')),
    fps: s.optional({ ...fpsSchema, anyOf: [...fpsSchema.anyOf!, { type: 'null' }] }),
    sampleRate: s.optional(s.integer('Audio sample rate.')),
    channels: s.optional(s.integer('Audio channels.')),
    videoCodec: s.optional(s.string('Codec name.')),
    audioCodec: s.optional(s.string('Codec name.')),
    rotation: s.optional(s.number('Display rotation.'))
  },
  'What ffprobe found. Filled in by the app when left out.'
)

type ProbeArgs = Partial<Omit<MediaProbe, 'duration' | 'fps'>> & { duration?: TimeInput; fps?: unknown }

export const projectCommands: CommandSpec[] = [
  defineCommand<{ name: string }>({
    id: 'project.rename',
    label: 'Rename Project',
    menuPath: ['File', 'Rename Project'],
    shortcut: null,
    doc: 'Renames the project.',
    params: s.object({ name: s.string('New name.') }),
    run: (p, a) => ({ ...p, name: a.name.trim() || fail('name is empty') })
  }),
  defineCommand<{ name: string; parentId?: Id }>({
    id: 'bin.create',
    label: 'New Bin',
    menuPath: ['File', 'New', 'Bin'],
    shortcut: 'CmdOrCtrl+B',
    doc: 'Makes a folder in the project panel. Returns { binId }.',
    params: s.object({ name: s.string('Bin name.'), parentId: s.optional(s.string('Parent bin, root when left out.')) }),
    run: (p, a, ctx) => {
      const parentId = binOrRoot(p, a.parentId)
      const id = ctx.newId('bin')
      return { state: { ...p, bins: { ...p.bins, [id]: { id, name: a.name, parentId } } }, result: { binId: id } }
    }
  }),
  defineCommand<{ binId: Id; name: string }>({
    id: 'bin.rename',
    label: 'Rename Bin',
    menuPath: null,
    shortcut: null,
    doc: 'Renames a bin.',
    params: s.object({ binId: s.string('Bin id.'), name: s.string('New name.') }),
    run: (p, a) => {
      const b = p.bins[a.binId] ?? fail(`no bin ${a.binId}`)
      return { ...p, bins: { ...p.bins, [b.id]: { ...b, name: a.name } } }
    }
  }),
  defineCommand<{ binId: Id }>({
    id: 'bin.delete',
    label: 'Delete Bin',
    menuPath: null,
    shortcut: null,
    doc: 'Deletes a bin. Its items and sub-bins move up to the parent.',
    params: s.object({ binId: s.string('Bin id.') }),
    run: (p, a) => {
      const b = p.bins[a.binId] ?? fail(`no bin ${a.binId}`)
      if (b.parentId === null) fail('the root bin stays')
      const bins = { ...p.bins }
      delete bins[b.id]
      for (const x of Object.values(bins)) if (x.parentId === b.id) bins[x.id] = { ...x, parentId: b.parentId }
      const items = { ...p.items }
      for (const it of Object.values(items)) if (it.binId === b.id) items[it.id] = { ...it, binId: b.parentId }
      return { ...p, bins, items }
    }
  }),
  defineCommand<{ itemId: Id; name: string }>({
    id: 'item.rename',
    label: 'Rename',
    menuPath: ['Edit', 'Rename'],
    shortcut: null,
    doc: 'Renames a project item (media, sequence, subclip or graphic).',
    params: s.object({ itemId: s.string('Item id.'), name: s.string('New name.') }),
    run: (p, a) => setItem(p, { ...getItem(p, a.itemId), name: a.name })
  }),
  defineCommand<{ itemIds: Id[]; binId: Id }>({
    id: 'item.move_to_bin',
    label: 'Move to Bin',
    menuPath: null,
    shortcut: null,
    doc: 'Moves project items into a bin.',
    params: s.object({ itemIds: s.array(s.string('Item id.'), 'Items to move.', { minItems: 1 }), binId: s.string('Target bin.') }),
    run: (p, a) => {
      const binId = binOrRoot(p, a.binId)
      let next = p
      for (const id of a.itemIds) next = setItem(next, { ...getItem(next, id), binId })
      return next
    }
  }),
  defineCommand<{ itemIds: Id[]; force?: boolean }>({
    id: 'item.delete',
    label: 'Delete from Project',
    menuPath: ['Edit', 'Delete from Project'],
    shortcut: null,
    doc: 'Removes project items. Refuses while an item is used on a timeline unless force is true, which also removes those clips.',
    params: s.object({
      itemIds: s.array(s.string('Item id.'), 'Items to delete.', { minItems: 1 }),
      force: s.optional(s.boolean('Also remove clips that use them.'))
    }),
    run: (p, a) => {
      const gone = new Set(a.itemIds)
      for (const id of gone) getItem(p, id)
      if (!a.force) {
        for (const id of gone) {
          const used = usagesOf(p, id).filter((u) => !gone.has(u))
          if (used.length) fail(`${p.items[id].name} is still used by ${used.slice(0, 3).join(', ')}`)
        }
      }
      const items: Record<Id, ProjectItem> = {}
      for (const it of Object.values(p.items)) {
        if (gone.has(it.id)) continue
        if (it.kind === 'sequence') {
          const strip = (t: (typeof it.videoTracks)[number]): typeof t => {
            const kept = t.items.filter((c) => !gone.has(c.itemRef))
            return kept.length === t.items.length ? t : { ...t, items: kept }
          }
          items[it.id] = { ...it, videoTracks: it.videoTracks.map(strip), audioTracks: it.audioTracks.map(strip) }
        } else if (it.kind === 'subclip' && gone.has(it.sourceId)) continue
        else items[it.id] = it
      }
      return { ...p, items }
    }
  }),
  defineCommand<{ path: string; name?: string; binId?: Id; libraryId?: string; info?: ProbeArgs }>({
    id: 'media.import',
    label: 'Import Media',
    menuPath: ['File', 'Import'],
    shortcut: 'CmdOrCtrl+I',
    doc: 'Adds a video, audio or image file to the project. Agents pass libraryId (a TrendDeck media library id) and the app resolves the file and probes it. Returns { mediaId }.',
    params: s.object({
      path: s.string('File path. The app fills this in from libraryId.'),
      name: s.optional(s.string('Display name, the file name when left out.')),
      binId: s.optional(s.string('Bin to put it in.')),
      libraryId: s.optional(s.string('Media library id it came from.')),
      info: s.optional(probeSchema)
    }),
    run: (p, a, ctx) => {
      if (!a.info) fail('media.import needs probe info, import through the app so it can read the file')
      const { duration, fps, ...rest } = a.info
      const info = probeDefaults({
        ...rest,
        fps: fps === undefined || fps === null ? null : parseFps(fps),
        duration: duration === undefined ? 0 : rawTime(duration, FPS.f30)
      })
      if (!info.hasVideo && !info.hasAudio) fail('file has no video or audio')
      if (!info.isStill && info.duration <= 0) fail('file has no length')
      const id = ctx.newId('media')
      const name = a.name ?? a.path.split(/[\\/]/).pop() ?? 'Media'
      const media = createMedia({ id, name, binId: binOrRoot(p, a.binId), path: a.path, info, libraryId: a.libraryId ?? null })
      return { state: setItem(p, media), result: { mediaId: id } }
    }
  }),
  defineCommand<{ mediaId: Id; proxyPath: string | null }>({
    id: 'media.set_proxy',
    label: 'Attach Proxy',
    menuPath: null,
    shortcut: null,
    doc: 'Points a media item at its low resolution editing proxy, or clears it with null.',
    params: s.object({ mediaId: s.string('Media id.'), proxyPath: { description: 'Proxy file path or null.', anyOf: [{ type: 'string' }, { type: 'null' }] } }),
    run: (p, a) => {
      const m = getItem(p, a.mediaId)
      if (m.kind !== 'media') fail(`${a.mediaId} is not media`)
      return setItem(p, { ...m, proxyPath: typeof a.proxyPath === 'string' ? a.proxyPath : null })
    }
  }),
  defineCommand<{ mediaId: Id; path: string }>({
    id: 'media.relink',
    label: 'Relink Media',
    menuPath: null,
    shortcut: null,
    doc: 'Points a media item at a moved file.',
    params: s.object({ mediaId: s.string('Media id.'), path: s.string('New file path.') }),
    run: (p, a) => {
      const m = getItem(p, a.mediaId)
      if (m.kind !== 'media') fail(`${a.mediaId} is not media`)
      return setItem(p, { ...m, path: a.path })
    }
  }),
  defineCommand<{ sourceId: Id; in: TimeInput; out: TimeInput; name?: string; binId?: Id }>({
    id: 'subclip.create',
    label: 'Make Subclip',
    menuPath: ['Clip', 'Make Subclip'],
    shortcut: null,
    doc: 'Saves a range of a media item as its own item. Returns { subclipId }.',
    params: s.object({
      sourceId: s.string('Media id.'),
      in: s.time('Range start in the media.'),
      out: s.time('Range end in the media.'),
      name: s.optional(s.string('Name.')),
      binId: s.optional(s.string('Bin.'))
    }),
    run: (p, a, ctx) => {
      const src = getItem(p, a.sourceId)
      if (src.kind !== 'media') fail('subclips are made from media')
      const fps = src.info.fps ?? p.settings.fps
      const inT = rawTime(a.in, fps)
      const outT = rawTime(a.out, fps)
      if (inT < 0 || outT <= inT) fail('subclip range is empty')
      if (!src.info.isStill && outT > src.info.duration) fail('subclip runs past the end of the media')
      const id = ctx.newId('subclip')
      return {
        state: setItem(p, { kind: 'subclip', id, name: a.name ?? `${src.name} sub`, binId: binOrRoot(p, a.binId ?? src.binId), sourceId: src.id, in: inT, out: outT }),
        result: { subclipId: id }
      }
    }
  }),
  defineCommand<{
    name?: string
    preset?: SequencePreset
    width?: number
    height?: number
    fps?: unknown
    videoTracks?: number
    audioTracks?: number
    binId?: Id
  }>({
    id: 'sequence.create',
    label: 'New Sequence',
    menuPath: ['File', 'New', 'Sequence'],
    shortcut: 'CmdOrCtrl+N',
    doc: 'Makes an empty timeline. Pick a preset or give width, height and fps; anything left out comes from project settings. Returns { sequenceId, videoTrackIds, audioTrackIds }.',
    params: s.object({
      name: s.optional(s.string('Name.')),
      preset: s.optional(s.enum(Object.keys(SEQUENCE_PRESETS), 'Frame size preset.')),
      width: s.optional(s.integer('Frame width.', { minimum: 16, maximum: 8192 })),
      height: s.optional(s.integer('Frame height.', { minimum: 16, maximum: 8192 })),
      fps: s.optional(fpsSchema),
      videoTracks: s.optional(s.integer('Video track count, default 2.', { minimum: 0, maximum: 32 })),
      audioTracks: s.optional(s.integer('Audio track count, default 2.', { minimum: 0, maximum: 32 })),
      binId: s.optional(s.string('Bin.'))
    }),
    run: (p, a, ctx) => {
      const preset = a.preset ? SEQUENCE_PRESETS[a.preset] : null
      const width = a.width ?? preset?.width ?? p.settings.width
      const height = a.height ?? preset?.height ?? p.settings.height
      if (width % 2 || height % 2) fail('frame width and height must be even')
      const id = ctx.newId('seq')
      const videoTrackIds = Array.from({ length: a.videoTracks ?? 2 }, () => ctx.newId('track'))
      const audioTrackIds = Array.from({ length: a.audioTracks ?? 2 }, () => ctx.newId('track'))
      const seq = createSequence({
        id,
        name: a.name ?? 'Sequence',
        binId: binOrRoot(p, a.binId),
        fps: a.fps === undefined ? p.settings.fps : parseFps(a.fps),
        width,
        height,
        sampleRate: p.settings.sampleRate,
        videoTrackIds,
        audioTrackIds
      })
      return { state: setItem(p, seq), result: { sequenceId: id, videoTrackIds, audioTrackIds } }
    }
  }),
  defineCommand<{ sequenceId: Id; name?: string; width?: number; height?: number; fps?: unknown }>({
    id: 'sequence.set_settings',
    label: 'Sequence Settings',
    menuPath: ['Sequence', 'Settings'],
    shortcut: null,
    doc: 'Changes frame size or rate. Changing fps keeps every clip at the same exact time.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      name: s.optional(s.string('Name.')),
      width: s.optional(s.integer('Frame width.', { minimum: 16, maximum: 8192 })),
      height: s.optional(s.integer('Frame height.', { minimum: 16, maximum: 8192 })),
      fps: s.optional(fpsSchema)
    }),
    run: (p, a) => {
      const seq = getSequence(p, a.sequenceId)
      const next = {
        ...seq,
        name: a.name ?? seq.name,
        width: a.width ?? seq.width,
        height: a.height ?? seq.height,
        fps: a.fps === undefined ? seq.fps : parseFps(a.fps)
      }
      if (next.width % 2 || next.height % 2) fail('frame width and height must be even')
      return setItem(p, next)
    }
  }),
  defineCommand<{ text: string; name?: string; width?: number; height?: number; style?: Record<string, string | number | boolean>; duration?: TimeInput; binId?: Id }>({
    id: 'graphic.create_text',
    label: 'New Title',
    menuPath: ['File', 'New', 'Title'],
    shortcut: 'CmdOrCtrl+T',
    doc: 'Makes a text title graphic (an image doc with one centred text layer) to place with clip.add. Style keys come from the text_style effect. Returns { graphicId, layerId }.',
    params: s.object({
      text: s.string('The words.'),
      name: s.optional(s.string('Name.')),
      width: s.optional(s.integer('Canvas width, project width when left out.', { minimum: 1 })),
      height: s.optional(s.integer('Canvas height.', { minimum: 1 })),
      style: s.optional({ type: 'object', description: 'text_style values.' }),
      duration: s.optional(s.time('Default length on a timeline, 5 s when left out.')),
      binId: s.optional(s.string('Bin.'))
    }),
    run: (p, a, ctx) => {
      const doc = createImageDoc(a.width ?? p.settings.width, a.height ?? p.settings.height)
      const layerId = ctx.newId('layer')
      const layer = createTextLayer(layerId, doc, a.text, a.style)
      const id = ctx.newId('graphic')
      const g = createGraphic({
        id,
        name: a.name ?? (a.text.slice(0, 32) || 'Title'),
        binId: binOrRoot(p, a.binId),
        doc: { ...doc, layers: [layer] },
        defaultDuration: a.duration === undefined ? secondsToTicks(5) : seqTime(a.duration, p.settings.fps)
      })
      return { state: setItem(p, g), result: { graphicId: id, layerId } }
    }
  }),
  defineCommand<{ sequenceId: Id; at: TimeInput; label?: string; duration?: TimeInput; color?: string }>({
    id: 'marker.add',
    label: 'Add Marker',
    menuPath: ['Sequence', 'Add Marker'],
    shortcut: 'M',
    doc: 'Drops a marker on the sequence. Returns { markerId }.',
    params: s.object({
      sequenceId: s.string('Sequence id.'),
      at: s.time('Where.'),
      label: s.optional(s.string('Note.')),
      duration: s.optional(s.time('Length, 0 for a point.')),
      color: s.optional(s.string('#RRGGBB.'))
    }),
    run: (p, a, ctx) => {
      const seq = getSequence(p, a.sequenceId)
      const id = ctx.newId('marker')
      const m = { id, at: seqTime(a.at, seq.fps), duration: a.duration === undefined ? 0 : seqTime(a.duration, seq.fps), label: a.label ?? '', color: a.color ?? '#F5C518' }
      const markers = [...seq.markers, m].sort((x, y) => x.at - y.at)
      return { state: setItem(p, { ...seq, markers }), result: { markerId: id } }
    }
  }),
  defineCommand<{ sequenceId: Id; markerId: Id }>({
    id: 'marker.remove',
    label: 'Remove Marker',
    menuPath: null,
    shortcut: null,
    doc: 'Deletes a marker.',
    params: s.object({ sequenceId: s.string('Sequence id.'), markerId: s.string('Marker id.') }),
    run: (p, a) => {
      const seq = getSequence(p, a.sequenceId)
      const markers = seq.markers.filter((m) => m.id !== a.markerId)
      if (markers.length === seq.markers.length) fail(`no marker ${a.markerId}`)
      return setItem(p, { ...seq, markers })
    }
  })
]
