import { counterIds, createProject, EditorSession, type CommandResult, type MediaProbe } from '@shared/editor'

export function ok<T = Record<string, unknown>>(r: CommandResult): T {
  if (!r.ok) throw new Error(`command failed: ${r.reason}`)
  return r.result as T
}

export interface Built {
  session: EditorSession
  seqId: string
  clipIds: Record<string, string>
}

// a small edit touching every export feature: dissolve, title with fade, keyframed scale,
// speed change, volume, captions, a dip transition and an image doc with shapes
export function buildEdit(paths: { video: string; still: string }, probes: { video: MediaProbe; still: MediaProbe }): Built {
  const session = new EditorSession(createProject({ id: 'proj_fixture', name: 'Fixture', settings: { width: 640, height: 360 } }), { newId: counterIds(), freeze: true })
  const media = ok<{ mediaId: string }>(session.execute('media.import', { path: paths.video, info: { ...probes.video, duration: { ticks: probes.video.duration } } })).mediaId
  const still = ok<{ mediaId: string }>(session.execute('media.import', { path: paths.still, info: { ...probes.still, duration: { ticks: probes.still.duration } } })).mediaId
  const { sequenceId: seqId, videoTrackIds } = ok<{ sequenceId: string; videoTrackIds: string[] }>(
    session.execute('sequence.create', { name: 'Edit', width: 640, height: 360, fps: 30 })
  )
  const r = session.batch([
    { id: 'clip.add', args: { sequenceId: seqId, itemId: media, at: 0, sourceIn: 0, duration: 2 } },
    { id: 'clip.add', args: { sequenceId: seqId, itemId: media, at: 2, sourceIn: 1.5, duration: 2 } },
    { id: 'transition.add', args: { clipId: '$1.clipIds.0', duration: 0.5 } },
    { id: 'keyframe.add', args: { clipId: '$0.clipIds.0', defId: 'transform', key: 'scale', at: 0, value: 100 } },
    { id: 'keyframe.add', args: { clipId: '$0.clipIds.0', defId: 'transform', key: 'scale', at: 2, value: 130, ease: 'ease_in_out' } },
    { id: 'effect.add', args: { clipId: '$1.clipIds.1', defId: 'volume', params: { gain: -6 } } },
    { id: 'effect.add', args: { clipId: '$1.clipIds.0', defId: 'color', params: { saturation: 50, contrast: 20 } } },
    { id: 'graphic.create_text', args: { text: 'Hello {world}: it\'s 100%', width: 640, height: 360, style: { size: 40, background_opacity: 50 } } },
    { id: 'clip.add', args: { sequenceId: seqId, itemId: '$7.graphicId', at: 0.5, duration: 2.5, trackId: videoTrackIds[1] } },
    { id: 'effect.set_param', args: { clipId: '$8.clipIds.0', defId: 'fade', key: 'fade_in', value: 0.3 } },
    { id: 'clip.add', args: { sequenceId: seqId, itemId: media, at: 4, sourceIn: 0, duration: 2 } },
    { id: 'clip.set_speed', args: { clipId: '$10.clipIds.0', speed: 2 } },
    { id: 'image.create', args: { width: 320, height: 180, background: '#203040' } },
    { id: 'image.layer_add', args: { graphicId: '$12.graphicId', type: 'raster', mediaId: still, transform: { scaleX: 0.5, scaleY: 0.5 } } },
    { id: 'image.layer_add', args: { graphicId: '$12.graphicId', type: 'shape', fill: '#FF0000', width: 40, height: 40, opacity: 80 } },
    { id: 'clip.add', args: { sequenceId: seqId, itemId: '$12.graphicId', at: 5, duration: 1 } },
    { id: 'transition.add', args: { clipId: '$15.clipIds.0', defId: 'dip_to_color', duration: 0.4, alignment: 'end' } },
    { id: 'caption.track_add', args: { sequenceId: seqId, style: { size: 24 } } },
    { id: 'caption.add', args: { sequenceId: seqId, start: 0.2, end: 1.8, text: 'First {caption}, with a comma' } },
    { id: 'caption.add', args: { sequenceId: seqId, start: 2, end: 4, text: 'Second one' } }
  ])
  if (!r.ok) throw new Error(JSON.stringify(r.steps.at(-1)))
  const res = (i: number): { clipIds: string[] } => (r.steps[i] as { result: { clipIds: string[] } }).result
  return { session, seqId, clipIds: { a: res(0).clipIds[0], b: res(1).clipIds[0], title: res(8).clipIds[0], fast: res(10).clipIds[0], image: res(15).clipIds[0] } }
}

export const VIDEO_PROBE: MediaProbe = {
  duration: 4 * 254_016_000_000,
  hasVideo: true,
  hasAudio: true,
  isStill: false,
  width: 320,
  height: 240,
  fps: { num: 30, den: 1 },
  sampleRate: 44100,
  channels: 1,
  videoCodec: 'h264',
  audioCodec: 'aac',
  rotation: 0
}

export const STILL_PROBE: MediaProbe = { ...VIDEO_PROBE, duration: 0, hasAudio: false, isStill: true, width: 200, height: 200, fps: null, sampleRate: 0, channels: 0, videoCodec: 'png', audioCodec: '' }
