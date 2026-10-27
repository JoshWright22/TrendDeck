import { counterIds, createProject } from '../factory'
import { checkProject } from '../timeline'
import { EditorSession, type CommandResult } from '../session'
import type { Project, SequenceItem, TrackItem } from '../model'
import { secondsToTicks } from '../time'

export function ok<T = Record<string, unknown>>(r: CommandResult): T {
  if (!r.ok) throw new Error(`command failed: ${r.reason}`)
  return r.result as T
}

export const SEC = secondsToTicks(1)

// a frozen session with one 10 s 30 fps clip with sound, one 4 s audio file and a 30 fps sequence
export function setup(): {
  session: EditorSession
  mediaId: string
  musicId: string
  seqId: string
  v1: string
  v2: string
  a1: string
  a2: string
} {
  let now = 1_700_000_000_000
  const session = new EditorSession(createProject({ id: 'proj_1', name: 'Test' }), { newId: counterIds(), now: () => now++, freeze: true })
  const { mediaId } = ok<{ mediaId: string }>(
    session.execute('media.import', {
      path: 'C:/media/talk.mp4',
      info: { duration: 10, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, sampleRate: 48000, channels: 2 }
    })
  )
  const { mediaId: musicId } = ok<{ mediaId: string }>(
    session.execute('media.import', { path: 'C:/media/music.m4a', info: { duration: 4, hasAudio: true, sampleRate: 48000, channels: 2 } })
  )
  const r = ok<{ sequenceId: string; videoTrackIds: string[]; audioTrackIds: string[] }>(session.execute('sequence.create', { name: 'Main', fps: 30 }))
  return { session, mediaId, musicId, seqId: r.sequenceId, v1: r.videoTrackIds[0], v2: r.videoTrackIds[1], a1: r.audioTrackIds[0], a2: r.audioTrackIds[1] }
}

export function seqOf(p: Project, id: string): SequenceItem {
  const s = p.items[id]
  if (s?.kind !== 'sequence') throw new Error('not a sequence')
  return s
}

export function clipsOn(p: Project, seqId: string, trackId: string): TrackItem[] {
  const s = seqOf(p, seqId)
  return [...s.videoTracks, ...s.audioTracks].find((t) => t.id === trackId)!.items
}

// start/end in seconds, for readable assertions
export function spans(items: TrackItem[]): [number, number][] {
  return items.map((c) => [c.start / SEC, (c.start + c.duration) / SEC])
}

export { checkProject }
