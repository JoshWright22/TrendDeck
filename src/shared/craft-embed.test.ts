import { describe, expect, it } from 'vitest'
import {
  countsAsEdit,
  describeChanges,
  diffFilmcraft,
  diffGeneric,
  fcSequenceFrom,
  formatCraftReview,
  frameAt,
  markerName,
  markerParams,
  snapTicks,
  timecode,
  TICKS_PER_SECOND,
  toSeconds,
  toTicks,
  TurnGroups,
  stageHeight,
  MIN_STAGE_HEIGHT,
  type FcSnapshot
} from './craft-embed'

const fps30 = { num: 30, den: 1 }
const ntsc = { num: 30000, den: 1001 }

describe('time and markers', () => {
  it('converts seconds and ticks both ways', () => {
    expect(toTicks(1)).toBe(TICKS_PER_SECOND)
    expect(toTicks(2.5)).toBe(635_040_000_000)
    expect(toSeconds(762_048_000_000)).toBe(3)
    expect(toTicks(-1)).toBe(0)
  })

  it('writes non drop frame timecode', () => {
    expect(timecode(0, fps30)).toBe('00:00:00:00')
    expect(timecode(65.5, fps30)).toBe('00:01:05:15')
    expect(timecode(3661 + 29 / 30, fps30)).toBe('01:01:01:29')
    // 29.97 counts 30 frames a timecode second
    expect(timecode(1, ntsc)).toBe('00:00:00:29')
  })

  it('snaps to the start of the frame', () => {
    expect(frameAt(2.0999, fps30)).toBe(62)
    expect(snapTicks(2.0999, fps30)).toBe(toTicks(62 / 30))
  })

  it('makes a point marker for a comment at one time', () => {
    const p = markerParams({ from: 2, to: 2, text: 'too slow here' }, fps30)
    expect(p).toEqual({ target: 'program', time: toTicks(2), name: 'too slow here', comment: 'too slow here' })
  })

  it('makes a range marker that covers the highlighted frames', () => {
    const p = markerParams({ from: 4, to: 1.5, text: 'cut this part, it drags on and on and on forever and ever' }, fps30)
    expect(p.time).toBe(toTicks(1.5))
    expect(p.durationFrames).toBe(75)
    expect(p.comment).toBe('cut this part, it drags on and on and on forever and ever')
    expect(String(p.name).length).toBeLessThanOrEqual(40)
    expect(p.name).toBe('cut this part, it drags on and on and on')
  })

  it('names a marker after the first words', () => {
    expect(markerName('  a   b ')).toBe('a b')
    expect(markerName('x'.repeat(60))).toBe('x'.repeat(40))
  })

  it('formats comments for the agent with marker ids and timecodes', () => {
    const text = formatCraftReview({ cardId: 'c1', projectId: 'p1', projectName: 'Launch', appName: 'FilmCraft', file: 'Launch.fcproj' }, [
      { marker: 18, sequence: 8, sequenceName: 'Main cut', from: 2, to: 3, inTimecode: '00:00:02:00', outTimecode: '00:00:03:00', text: 'faster', frameId: 'f-1', box: { x: 1, y: 2, width: 3, height: 4 }, frameWidth: 100, frameHeight: 50 }
    ])
    expect(text).toContain('sequence "Main cut" (id 8)')
    expect(text).toContain('1. 00:00:02:00 to 00:00:03:00: faster (marker 18, frame f-1, box x 1, y 2, 3 by 4 of 100 by 50)')
    const json = JSON.parse(/```trenddeck-craft-review\n(.*)\n```/.exec(text)![1])
    expect(json).toMatchObject({ card: 'c1', sequence: 8, comments: [{ marker: 18, in: '00:00:02:00', out: '00:00:03:00', fromSeconds: 2, toSeconds: 3, frameId: 'f-1' }] })
    expect(() => formatCraftReview({ cardId: 'c', projectId: 'p', projectName: '', appName: 'FilmCraft', file: null }, [])).toThrow()
  })
})

const T = TICKS_PER_SECOND

// sequence.inspect as FilmCraft 0.13 answers it, cut down
function inspect(clips: { clip: number; start: number; end: number; sourceIn?: number; link?: number; track?: number; effects?: string[] }[], markers: unknown[] = []) {
  const video: { items: unknown[] }[] = [{ items: [] }, { items: [] }]
  const audio: { items: unknown[] }[] = [{ items: [] }]
  for (const c of clips) {
    const item = { clip: c.clip, name: 'clip.mp4', start: c.start * T, end: c.end * T, sourceIn: (c.sourceIn ?? c.start) * T, sourceOut: (c.sourceIn ?? c.start) * T + (c.end - c.start) * T, speed: 1, enabled: true, link: c.link ?? null, effects: (c.effects ?? ['motion']).map((effect) => ({ effect })) }
    video[c.track ?? 0].items.push(item)
    // its sound, linked
    audio[0].items.push({ ...item, clip: c.clip + 1000, effects: [{ effect: 'volume' }] })
  }
  return { id: 8, name: 'Main cut', settings: { frame_rate: { num: 30, den: 1 } }, video, audio, markers }
}

const snap = (seq: ReturnType<typeof inspect>, captions?: unknown, names: Record<string, string> = { '8': 'Main cut' }): FcSnapshot => ({
  kind: 'filmcraft',
  sequences: [fcSequenceFrom(seq, captions)!],
  names
})

describe('what the user changed', () => {
  it('reads sequence.inspect, leaving linked sound and default effects out of the diff', () => {
    const s = fcSequenceFrom(inspect([{ clip: 10, start: 0, end: 3, link: 9 }]))!
    expect(s.clips.map((c) => c.track)).toEqual(['V1', 'A1'])
    expect(s.clips[0].effects).toEqual([])
    expect(s.captions).toBeNull()
  })

  it('names trims, moves, splits, deletes and effects', () => {
    const a = snap(inspect([
      { clip: 10, start: 0, end: 3, link: 9 },
      { clip: 12, start: 3, end: 10, link: 13 },
      { clip: 20, start: 10, end: 12, link: 21 }
    ]))
    const b = snap(inspect([
      // its end trimmed by 1.2 s
      { clip: 10, start: 0, end: 1.8, link: 9 },
      // moved later, same length
      { clip: 12, start: 4, end: 11, link: 13, effects: ['motion', 'gaussian_blur'] },
      // a new piece from a split
      { clip: 30, start: 11, end: 12, link: 31, track: 1 }
    ]))
    const lines = diffFilmcraft(a, b)
    expect(lines).toContain('shortened clip 10 "clip.mp4" by 1.2 s at its end, now 00:00:00:00 to 00:00:01:24')
    expect(lines).toContain('moved clip 12 "clip.mp4" from 00:00:03:00 to 00:00:04:00')
    expect(lines).toContain('added effect gaussian_blur to clip 12 "clip.mp4"')
    expect(lines).toContain('added clip 30 "clip.mp4" on V2 at 00:00:11:00 (1 s)')
    expect(lines).toContain('deleted clip 20 "clip.mp4" from V1, it was at 00:00:10:00 (2 s)')
    // the sound clips moved with their pictures and aren't named twice
    expect(lines.some((l) => /clip 10\d\d/.test(l))).toBe(false)
  })

  it('names markers, but not the ones that came from comments', () => {
    const a = snap(inspect([], [{ id: 1, name: 'old', comment: '', start: 0, duration: 0 }]))
    const b = snap(inspect([], [
      { id: 2, name: 'too slow', comment: 'speed it up', start: 65 * T, duration: 2 * T },
      { id: 3, name: 'from a comment', comment: '', start: 0, duration: 0 }
    ]))
    const lines = diffFilmcraft(a, b, new Set([3]))
    expect(lines).toEqual(['added marker 2 "too slow" ("speed it up") at 00:01:05:00 to 00:01:07:00', 'removed marker 1 "old" at 00:00:00:00'])
  })

  it('names caption edits only when both looks read the captions', () => {
    const caps = (text: string) => ({ tracks: [{ captions: [{ id: 17, text, start: T, end: 3 * T }] }] })
    const a = snap(inspect([]), caps('Hello there'))
    const b = snap(inspect([]), caps('Hi there'))
    expect(diffFilmcraft(a, b)).toEqual(['changed the caption at 00:00:01:00 from "Hello there" to "Hi there"'])
    expect(diffFilmcraft(a, snap(inspect([])))).toEqual([])
  })

  it('names new and removed sequences', () => {
    const a = snap(inspect([]))
    const b = { ...snap(inspect([])), names: { '8': 'Main cut', '40': 'Faster open' } }
    expect(diffFilmcraft(a, b)).toEqual(['added sequence "Faster open" (id 40)'])
    expect(diffFilmcraft(b, a)).toEqual(['deleted sequence "Faster open" (id 40)'])
  })

  it('matches up objects with ids in any other app', () => {
    const a = { kind: 'generic' as const, tree: { revision: 1, layers: [{ id: 1, name: 'Title', text: 'Old title', x: 0 }, { id: 2, name: 'Logo' }] } }
    const b = { kind: 'generic' as const, tree: { revision: 2, layers: [{ id: 1, name: 'Title', text: 'New title', x: 10 }, { id: 3, name: 'Arrow' }] } }
    expect(diffGeneric(a, b)).toEqual(['changed text to "New title", x of layer "Title"', 'added layer "Arrow"', 'removed layer "Logo"'])
  })

  it('says it in one line per app', () => {
    expect(describeChanges('FilmCraft', 'a.fcproj', ['x', 'y'])).toBe('FilmCraft, a.fcproj: x; y.')
    expect(describeChanges('FilmCraft', null, [])).toBe('')
    expect(describeChanges('PhotoCraft', null, Array.from({ length: 30 }, (_, i) => `c${i}`))).toMatch(/; and 5 more changes\.$/)
  })
})

describe('one undo group per reply', () => {
  it('makes one checkpoint per reply and app project, even for edits at the same time', async () => {
    const groups = new TurnGroups<string>()
    let made = 0
    const start = async (): Promise<string> => `ck${++made}`
    const a = groups.open('t1', 'filmcraft', 'p1', start)
    const b = groups.open('t1', 'filmcraft', 'p1', start)
    expect(a.first).toBe(true)
    expect(b.first).toBe(false)
    expect(await a.value).toBe('ck1')
    expect(await b.value).toBe('ck1')
    expect(made).toBe(1)
    groups.edited('t1', 'filmcraft', 'p1')
    groups.edited('t1', 'filmcraft', 'p1')
    // another app, another group
    await groups.open('t1', 'photocraft', 'p1', start).value
    groups.edited('t1', 'photocraft', 'p1')
    // the next reply starts over
    expect(groups.open('t2', 'filmcraft', 'p1', start).first).toBe(true)
    const closed = groups.close('t1')
    expect(closed.map((g) => [g.key, g.edits])).toEqual([
      ['t1|filmcraft|p1', 2],
      ['t1|photocraft|p1', 1]
    ])
    expect(groups.edits('t1', 'filmcraft', 'p1')).toBe(0)
    expect(groups.get('t2', 'filmcraft', 'p1')).not.toBeNull()
  })

  it('tries again after a failed checkpoint', async () => {
    const groups = new TurnGroups<string>()
    const bad = groups.open('t1', 'filmcraft', 'p1', () => Promise.reject(new Error('no')))
    await expect(bad.value).rejects.toThrow('no')
    await Promise.resolve()
    expect(groups.open('t1', 'filmcraft', 'p1', async () => 'ok').first).toBe(true)
  })

  it('counts project edits, not exports, saves or looking around', () => {
    expect(countsAsEdit('command_run', { id: 'timeline.razor' })).toBe(true)
    expect(countsAsEdit('command_run', { id: 'file.exportMedia' })).toBe(false)
    expect(countsAsEdit('command_run', { id: 'playhead.set' })).toBe(false)
    expect(countsAsEdit('command_run', { id: 'file.save' })).toBe(false)
    expect(countsAsEdit('command_batch', { steps: [{ id: 'playhead.set' }, { id: 'markers.add' }] })).toBe(true)
    expect(countsAsEdit('media_import', { paths: [] })).toBe(true)
    expect(countsAsEdit('render_frame', {})).toBe(false)
    expect(countsAsEdit('doc_export', {})).toBe(false)
    expect(countsAsEdit('ui_click', {})).toBe(true)
    expect(countsAsEdit('ui_screenshot', {})).toBe(false)
  })
})

describe('embed size', () => {
  it('is 16:9 of the column inline but never shorter than the editor needs', () => {
    expect(stageHeight('inline', 772, 500)).toBe(434)
    expect(stageHeight('inline', 600, 500)).toBe(MIN_STAGE_HEIGHT)
    // a short chat cuts the window instead of squeezing it
    expect(stageHeight('inline', 772, 200)).toBe(434)
  })
  it('grows with the chat for large and fill', () => {
    expect(stageHeight('large', 772, 800)).toBe(720)
    expect(stageHeight('fill', 772, 800)).toBe(800)
    expect(stageHeight('fill', 772, 300)).toBe(MIN_STAGE_HEIGHT)
    expect(stageHeight('large', 772, 300)).toBe(434)
  })
})
