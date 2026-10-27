import { describe, expect, it } from 'vitest'
import { createProject, counterIds } from '../factory'
import { MIGRATIONS, parseProjectFile, ProjectFileError, migrateProject, serializeProject } from '../file'
import { SCHEMA_VERSION } from '../model'
import { EditorSession } from '../session'
import { applyPatch, diffProject } from '../sync'
import { createEditorToolHandler, editorToolDescriptors } from '../tools'
import { clipsOn, ok, setup, spans } from './fixtures'

describe('undo and redo', () => {
  it('steps through history and redo is dropped by a new edit', () => {
    const { session, mediaId, seqId, v1 } = setup()
    const p0 = session.project
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, audio: false }))
    const p1 = session.project
    ok(session.execute('clip.split', { sequenceId: seqId, at: 5 }))
    expect(session.undoLabel).toBe('Split')
    expect(session.undo()).toBe(true)
    expect(session.project).toBe(p1)
    expect(session.undo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(session.project).toBe(p1)
    ok(session.execute('marker.add', { sequenceId: seqId, at: 1 }))
    expect(session.canRedo).toBe(false)
    while (session.undo());
    // undo goes all the way back to the empty sequence, earlier imports included
    expect(Object.keys(session.project.items).length).toBeLessThan(Object.keys(p0.items).length)
    expect(clipsOn(p1, seqId, v1)).toHaveLength(1)
  })

  it('caps history at 200 levels', () => {
    const { session, seqId } = setup()
    for (let i = 0; i < 230; i++) ok(session.execute('marker.add', { sequenceId: seqId, at: i / 10 }))
    let n = 0
    while (session.undo()) n++
    expect(n).toBe(200)
  })

  it('failed commands change nothing and leave no history', () => {
    const { session } = setup()
    const before = session.project
    const v = session.version
    const r = session.execute('clip.split', { clipId: 'nope', at: 1 })
    expect(r.ok).toBe(false)
    expect(session.project).toBe(before)
    expect(session.version).toBe(v)
    expect(session.execute('nope.nothing', {}).ok).toBe(false)
    expect(session.execute('clip.split', { clipId: 1 }).ok).toBe(false)
  })

  it('snapshots are frozen, structural sharing keeps untouched items', () => {
    const { session, mediaId, seqId } = setup()
    const media = session.project.items[mediaId]
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    expect(session.project.items[mediaId]).toBe(media)
    expect(Object.isFrozen(session.project.items[seqId])).toBe(true)
  })
})

describe('batch and agent turns', () => {
  it('is one undo step and resolves $refs to earlier results', () => {
    const { session, mediaId } = setup()
    const before = session.project
    const r = session.batch([
      { id: 'sequence.create', args: { name: 'Short', preset: 'vertical_1080x1920' } },
      { id: 'clip.add', args: { sequenceId: '$0.sequenceId', itemId: mediaId } },
      { id: 'clip.split', args: { clipId: '$1.clipIds.0', at: 4 } }
    ])
    expect(r.ok).toBe(true)
    const seqId = (r.steps[0] as { result: { sequenceId: string; videoTrackIds: string[] } }).result
    expect(spans(clipsOn(session.project, seqId.sequenceId, seqId.videoTrackIds[0]))).toEqual([[0, 4], [4, 10]])
    session.undo()
    expect(session.project).toBe(before)
  })

  it('is all or nothing with stopOnError, partial without', () => {
    const { session, seqId } = setup()
    const before = session.project
    const steps = [
      { id: 'marker.add', args: { sequenceId: seqId, at: 1 } },
      { id: 'clip.split', args: { clipId: 'missing', at: 1 } },
      { id: 'marker.add', args: { sequenceId: seqId, at: 2 } }
    ]
    const r = session.batch(steps)
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(2)
    expect(session.project).toBe(before)
    const r2 = session.batch(steps, { stopOnError: false })
    expect(r2.ok).toBe(false)
    expect(r2.steps.map((x) => x.ok)).toEqual([true, false, true])
    const seq = session.project.items[seqId]
    expect(seq.kind === 'sequence' && seq.markers).toHaveLength(2)
  })

  it('groups an agent turn into one entry and reverts to a checkpoint', () => {
    const { session, mediaId, seqId } = setup()
    const cp = session.checkpoint('before agent turn')
    const start = session.project
    session.beginGroup('Agent: rough cut')
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    ok(session.execute('clip.split', { sequenceId: seqId, at: 3 }))
    session.endGroup()
    expect(session.history().undo.at(-1)).toBe('Agent: rough cut')
    const after = session.project
    ok(session.revertTo(cp))
    expect(session.project).toBe(start)
    // the revert itself can be undone
    session.undo()
    expect(session.project).toBe(after)
    session.undo()
    expect(session.project).toBe(start)
    expect(session.checkpoints().map((c) => c.label)).toEqual(['before agent turn'])
  })
})

describe('project files', () => {
  it('round trips through JSON', () => {
    const { session, mediaId, seqId } = setup()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    ok(session.execute('keyframe.add', { clipId: clipsOn(session.project, seqId, (session.project.items[seqId] as { videoTracks: { id: string }[] }).videoTracks[0].id)[0].id, defId: 'transform', key: 'scale', at: 1, value: 50 }))
    const text = serializeProject(session.project, 123)
    const { project, savedAt } = parseProjectFile(text)
    expect(savedAt).toBe(123)
    expect(project).toEqual(session.project)
  })

  it('runs migrations in order and refuses newer files', () => {
    const old = { ...createProject({ id: 'p' }), schemaVersion: 0 } as Record<string, unknown>
    delete old.settings
    const migrations = [{ from: 0, up: (raw: Record<string, unknown>) => ({ ...raw, settings: { fps: { num: 25, den: 1 }, width: 1280, height: 720, sampleRate: 48000 } }) }]
    const up = migrateProject(old, [...migrations, ...MIGRATIONS])
    expect(up.schemaVersion).toBe(SCHEMA_VERSION)
    expect(up.settings.fps).toEqual({ num: 25, den: 1 })
    expect(() => migrateProject(old, [])).toThrow(/no upgrade path/)
    expect(() => migrateProject({ ...createProject({ id: 'p' }), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(ProjectFileError)
    expect(() => parseProjectFile('{"format":"other"}')).toThrow(ProjectFileError)
    expect(() => parseProjectFile('not json')).toThrow(ProjectFileError)
  })

  it('rejects files that break timeline invariants', () => {
    const { session, mediaId, seqId } = setup()
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, duration: 4, audio: false }))
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId, duration: 4, audio: false }))
    const raw = JSON.parse(serializeProject(session.project))
    const seq = raw.project.items[seqId]
    seq.videoTracks[0].items[1].start = seq.videoTracks[0].items[0].start
    expect(() => parseProjectFile(JSON.stringify(raw))).toThrow(/overlaps/)
  })
})

describe('sync patches', () => {
  it('sends only changed items and rebuilds the same project', () => {
    const { session, mediaId, musicId, seqId } = setup()
    const base = session.project
    const v0 = session.version
    ok(session.execute('clip.add', { sequenceId: seqId, itemId: mediaId }))
    ok(session.execute('item.delete', { itemIds: [musicId] }))
    const patch = diffProject(base, session.project, v0, session.version)
    expect(Object.keys(patch.items).sort()).toEqual([musicId, seqId].sort())
    expect(patch.items[musicId]).toBeNull()
    const mirror = applyPatch(JSON.parse(JSON.stringify(base)), v0, patch)
    expect(mirror).toEqual(session.project)
    expect(applyPatch(base, v0 + 1, patch)).toBeNull()
  })
})

describe('agent tools', () => {
  it('lists, runs, batches and inspects without leaking paths', async () => {
    const { session, mediaId, seqId } = setup()
    const handle = createEditorToolHandler({ getSession: () => session })
    expect(editorToolDescriptors().map((d) => d.name)).toEqual(['command_list', 'command_run', 'command_batch', 'project_inspect', 'sequence_inspect'])
    const list = await handle('command_list', { prefix: 'clip.' })
    expect(list.ok && (list.data as { commands: { id: string; params: unknown }[] }).commands.every((c) => c.id.startsWith('clip.') && c.params)).toBe(true)
    const run = await handle('command_run', { id: 'clip.add', args: { sequenceId: seqId, itemId: mediaId } })
    expect(run.ok).toBe(true)
    const bad = await handle('command_batch', { steps: [{ id: 'clip.split', args: { sequenceId: seqId, at: 99 } }] })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/step 0/)
    const proj = await handle('project_inspect', {})
    expect(JSON.stringify(proj)).not.toContain('C:/media')
    const seq = await handle('sequence_inspect', { sequenceId: seqId, from: 0, to: '00:00:05:00' })
    expect(seq.ok && (seq.data as { videoTracks: { clips: unknown[] }[] }).videoTracks.at(-1)!.clips).toHaveLength(1)
  })

  it('lets the host fill args before running', async () => {
    const session = new EditorSession(createProject({ id: 'p' }), { newId: counterIds() })
    const handle = createEditorToolHandler({
      getSession: () => session,
      prepare: async (_s, id, args) => (id === 'media.import' ? { ...args, path: `/lib/${args.libraryId}.mp4`, info: { duration: 3, hasVideo: true } } : args)
    })
    const r = await handle('command_run', { id: 'media.import', args: { libraryId: 'abc' } })
    expect(r.ok).toBe(true)
  })
})
