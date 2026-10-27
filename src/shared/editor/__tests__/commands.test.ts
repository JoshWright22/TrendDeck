import { describe, expect, it } from 'vitest'
import { commands, getCommand, menuTree, shortcutMap } from '../registry'
import { sourceOut, type Keyframe } from '../model'
import { resolveFrame } from '../resolve'
import { checkProject, clipsOn, ok, SEC, seqOf, setup, spans } from './fixtures'

describe('registry', () => {
  it('has unique ids, docs and object schemas', () => {
    const ids = commands().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of commands()) {
      expect(c.doc.length).toBeGreaterThan(10)
      expect(c.params.type).toBe('object')
    }
    for (const want of ['clip.split', 'clip.trim', 'clip.move', 'clip.ripple_delete', 'track.add', 'effect.add', 'effect.set_param', 'keyframe.add', 'sequence.create', 'media.import', 'caption.add', 'transcript.cut_words', 'image.layer_add']) {
      expect(getCommand(want), want).toBeTruthy()
    }
    expect(shortcutMap()['CmdOrCtrl+K']).toBe('clip.split')
    expect(menuTree().find((m) => m.label === 'Clip')?.children?.some((c) => c.commandId === 'clip.split')).toBe(true)
  })
})

describe('clip.add', () => {
  it('places media with sound as a linked video and audio pair', () => {
    const { session, mediaId, seqId, v1, a1 } = setup()
    const { clipIds } = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    expect(clipIds).toHaveLength(2)
    const v = clipsOn(session.project, seqId, v1)
    const a = clipsOn(session.project, seqId, a1)
    expect(spans(v)).toEqual([[0, 10]])
    expect(spans(a)).toEqual([[0, 10]])
    expect(v[0].linkId).toBeTruthy()
    expect(v[0].linkId).toBe(a[0].linkId)
  })

  it('appends at the end by default and refuses to play past the source', () => {
    const { session, mediaId, seqId, v1 } = setup()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, duration: 3 }))
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, sourceIn: 2, duration: 2 }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[0, 3], [3, 5]])
    const r = session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, sourceIn: 9, duration: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/past the end/)
  })
})

describe('split, trim, move keep tracks valid', () => {
  it('split leaves no overlap and keeps keyframes anchored in source time', () => {
    const { session, mediaId, seqId, v1, a1 } = setup()
    const { clipIds } = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 1 }))
    const vId = clipIds[0]
    ok(session.execute('keyframe.add', { clipId: vId, defId: 'transform', key: 'scale', at: 2, value: 100 }))
    ok(session.execute('keyframe.add', { clipId: vId, defId: 'transform', key: 'scale', at: 8, value: 200 }))
    const before = clipsOn(session.project, seqId, v1)[0]
    const keysBefore = (before.effects[0].params.scale as { keyframes: Keyframe[] }).keyframes
    const scaleAt = (t: number): number => {
      const f = resolveFrame(session.project, seqOf(session.project, seqId), Math.round(t * SEC))
      const layer = f.video.find((l) => l.kind === 'clip')
      return layer && layer.kind === 'clip' ? Number(layer.effects[0].params.scale) : NaN
    }
    const s6 = scaleAt(6)
    const { newClipIds } = ok<{ newClipIds: string[] }>(session.execute('clip.split', { clipId: vId, at: 5 }))
    expect(newClipIds).toHaveLength(2)
    const v = clipsOn(session.project, seqId, v1)
    const a = clipsOn(session.project, seqId, a1)
    expect(spans(v)).toEqual([[1, 5], [5, 11]])
    expect(spans(a)).toEqual([[1, 5], [5, 11]])
    // the right half of the video stays linked to the right half of the audio
    expect(v[1].linkId).toBe(a[1].linkId)
    expect(v[1].linkId).not.toBe(v[0].linkId)
    for (const c of v) expect((c.effects[0].params.scale as { keyframes: Keyframe[] }).keyframes).toEqual(keysBefore)
    expect(scaleAt(6)).toBeCloseTo(s6, 9)
    expect(v[1].sourceIn).toBe(4 * SEC)
    checkProject(session.project)
  })

  it('trim refuses to grow into a neighbour unless rippling', () => {
    const { session, mediaId, seqId, v1, a1 } = setup()
    const first = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 0, duration: 4 })).clipIds[0]
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 4, sourceIn: 5, duration: 4 }))
    const grow = session.execute('clip.trim', { clipId: first, edge: 'end', by: 1 })
    expect(grow.ok).toBe(false)
    ok(session.execute('clip.trim', { clipId: first, edge: 'end', by: 1, ripple: true }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[0, 5], [5, 9]])
    expect(spans(clipsOn(session.project, seqId, a1))).toEqual([[0, 5], [5, 9]])
    ok(session.execute('clip.trim', { clipId: first, edge: 'start', to: 2 }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[2, 5], [5, 9]])
    expect(clipsOn(session.project, seqId, v1)[0].sourceIn).toBe(2 * SEC)
    ok(session.execute('clip.trim', { clipId: first, edge: 'start', by: 1, ripple: true }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[2, 4], [4, 8]])
    expect(session.execute('clip.trim', { clipId: first, edge: 'start', by: -10 }).ok).toBe(false)
  })

  it('move overwrites by default, insert pushes, strict refuses', () => {
    const { session, mediaId, seqId, v1 } = setup()
    const a = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 0, duration: 4, audio: false })).clipIds[0]
    const b = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 6, duration: 4, audio: false })).clipIds[0]
    expect(session.execute('clip.move', { clipId: a, to: 4, mode: 'strict' }).ok).toBe(false)
    ok(session.execute('clip.move', { clipId: a, to: 4 }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[4, 8], [8, 10]])
    session.undo()
    ok(session.execute('clip.move', { clipId: b, to: 2, mode: 'insert' }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[0, 2], [2, 6], [6, 8]])
    checkProject(session.project)
  })

  it('locked tracks refuse edits', () => {
    const { session, mediaId, seqId, v1 } = setup()
    const id = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, audio: false })).clipIds[0]
    ok(session.execute('track.set', { sequenceId: seqId, trackId: v1, locked: true }))
    const r = session.canExecute('clip.split', { clipId: id, at: 5 })
    expect(r).toEqual({ reason: expect.stringMatching(/locked/) })
  })
})

describe('ripple delete', () => {
  it('closes the gap on every track and the captions', () => {
    const { session, mediaId, musicId, seqId, v1, a1, a2 } = setup()
    const ids = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 0, duration: 3 })).clipIds
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 3, sourceIn: 5, duration: 3 }))
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: musicId, at: 0, trackId: a2 }))
    ok(session.execute('caption.track_add', { sequenceId: seqId }))
    ok(session.execute('caption.add', { sequenceId: seqId, start: 1, end: 2, text: 'gone' }))
    ok(session.execute('caption.add', { sequenceId: seqId, start: 4, end: 5, text: 'kept' }))
    ok(session.execute('clip.ripple_delete', { clipIds: [ids[0]] }))
    const p = session.project
    expect(spans(clipsOn(p, seqId, v1))).toEqual([[0, 3]])
    expect(spans(clipsOn(p, seqId, a1))).toEqual([[0, 3]])
    // music was cut by the same range and pulled left
    expect(spans(clipsOn(p, seqId, a2))).toEqual([[0, 1]])
    expect(clipsOn(p, seqId, a2)[0].sourceIn).toBe(3 * SEC)
    expect(seqOf(p, seqId).captionTracks[0].cues.map((c) => [c.text, c.start / SEC])).toEqual([['kept', 1]])
    checkProject(p)
  })
})

describe('effects and keyframes', () => {
  it('validates params against the effect defs', () => {
    const { session, mediaId, seqId } = setup()
    const [v, a] = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId })).clipIds
    expect(session.execute('effect.add', { clipId: v, defId: 'volume' }).ok).toBe(false)
    expect(session.execute('effect.add', { clipId: a, defId: 'volume', params: { gain: 99 } }).ok).toBe(false)
    ok(session.execute('effect.add', { clipId: a, defId: 'volume', params: { gain: -6 } }))
    ok(session.execute('effect.set_param', { clipId: v, defId: 'fade', key: 'fade_in', value: '15f' }))
    const fade = clipsOn(session.project, seqId, seqOf(session.project, seqId).videoTracks[0].id)[0].effects[0]
    expect(fade.params.fade_in).toEqual({ value: SEC / 2 })
  })

  it('removing the last keyframes goes back to a constant', () => {
    const { session, mediaId, seqId, v1 } = setup()
    const v = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, audio: false })).clipIds[0]
    ok(session.execute('keyframe.add', { clipId: v, defId: 'transform', key: 'opacity', at: 1, value: 0 }))
    ok(session.execute('keyframe.add', { clipId: v, defId: 'transform', key: 'opacity', at: 2, value: 100 }))
    ok(session.execute('keyframe.remove', { clipId: v, defId: 'transform', key: 'opacity', at: 2 }))
    expect(clipsOn(session.project, seqId, v1)[0].effects[0].params.opacity).toEqual({ value: 0 })
  })

  it('transitions need handles on both sides of the cut', () => {
    const { session, mediaId, seqId } = setup()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 0, duration: 4, audio: false }))
    const b = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 4, sourceIn: 0, duration: 4, audio: false })).clipIds[0]
    // b starts at source 0, nothing before the cut to dissolve from
    expect(session.execute('transition.add', { clipId: b, duration: 1 }).ok).toBe(false)
    ok(session.execute('transition.add', { clipId: b, duration: 1, alignment: 'start' }))
    const f = resolveFrame(session.project, seqOf(session.project, seqId), Math.round(4.5 * SEC))
    const layers = f.video.filter((l) => l.kind === 'clip')
    expect(layers).toHaveLength(2)
    expect(layers[1].kind === 'clip' && layers[1].opacity).toBeCloseTo(0.5, 6)
  })
})

describe('transcripts and captions', () => {
  function withTranscript(): ReturnType<typeof setup> & { words: string[] } {
    const env = setup()
    const words = ok<{ wordIds: string[] }>(
      env.session.execute('transcript.set', {
        mediaId: env.mediaId,
        words: [
          { text: 'so', start: 0.5, end: 0.8 },
          { text: 'um', start: 1.0, end: 1.4 },
          { text: 'uh', start: 1.5, end: 2.0 },
          { text: 'hello', start: 2.2, end: 2.6 },
          { text: 'world.', start: 2.7, end: 3.0 },
          { text: 'bye', start: 6.0, end: 6.5 }
        ]
      })
    ).wordIds
    return { ...env, words }
  }

  it('cut_words removes the words and the pause between them, keeping a/v sync', () => {
    const { session, mediaId, seqId, v1, a1, words } = withTranscript()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    const r = ok<{ cuts: number }>(session.execute('transcript.cut_words', { sequenceId: seqId, wordIds: [words[1], words[2]] }))
    expect(r.cuts).toBe(1)
    const v = clipsOn(session.project, seqId, v1)
    expect(spans(v)).toEqual([[0, 1], [1, 9]])
    expect(spans(clipsOn(session.project, seqId, a1))).toEqual(spans(v))
    // the right part resumes at "uh"'s end in the media
    expect(v[1].sourceIn).toBe(2 * SEC)
    checkProject(session.project)
  })

  it('captions follow the edit', () => {
    const { session, mediaId, seqId, words } = withTranscript()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    ok(session.execute('transcript.cut_words', { sequenceId: seqId, wordIds: [words[1], words[2]] }))
    const { count } = ok<{ count: number }>(session.execute('caption.from_transcript', { sequenceId: seqId }))
    const cues = seqOf(session.project, seqId).captionTracks[0].cues
    expect(count).toBe(cues.length)
    expect(cues.map((c) => c.text)).toEqual(['so hello world.', 'bye'])
    // "bye" was at 6 s in the media, 1 s of um/uh was cut before it
    expect(cues[1].start / SEC).toBeCloseTo(5, 1)
  })

  it('speed changes keep source and keyframes, rescale length', () => {
    const { session, mediaId, seqId, v1 } = setup()
    const v = ok<{ clipIds: string[] }>(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, duration: 4 })).clipIds[0]
    ok(session.execute('clip.set_speed', { clipId: v, speed: 2 }))
    const c = clipsOn(session.project, seqId, v1)[0]
    expect(c.duration).toBe(2 * SEC)
    expect(sourceOut(c)).toBe(4 * SEC)
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, at: 3, duration: 1 }))
    expect(session.execute('clip.set_speed', { clipId: v, speed: 0.5 }).ok).toBe(false)
    ok(session.execute('clip.set_speed', { clipId: v, speed: 0.5, ripple: true }))
    expect(spans(clipsOn(session.project, seqId, v1))).toEqual([[0, 8], [9, 10]])
  })
})

describe('image documents', () => {
  it('builds layered images through image.* commands', () => {
    const { session, mediaId } = setup()
    const { graphicId } = ok<{ graphicId: string }>(session.execute('image.create', { width: 1080, height: 1080, background: '#112233' }))
    ok(session.execute('image.layer_add', { graphicId, type: 'raster', mediaId }))
    const { layerId } = ok<{ layerId: string }>(session.execute('image.layer_add', { graphicId, type: 'text', text: 'Hi', style: { size: 120 } }))
    ok(session.execute('image.layer_update', { graphicId, layerId, opacity: 50, transform: { y: 900 } }))
    expect(session.execute('image.layer_update', { graphicId, layerId, mediaId }).ok).toBe(false)
    ok(session.execute('image.layer_reorder', { graphicId, layerId, index: 0 }))
    const g = session.project.items[graphicId]
    expect(g.kind === 'graphic' && g.doc.layers.map((l) => l.type)).toEqual(['text', 'raster'])
    expect(g.kind === 'graphic' && g.doc.layers[0].type === 'text' && g.doc.layers[0].style.size).toBe(120)
  })
})
