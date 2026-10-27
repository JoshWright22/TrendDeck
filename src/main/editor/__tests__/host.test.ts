import { existsSync, mkdtempSync, promises as fs, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch, type EditorChangeEvent, type Project } from '@shared/editor'
import { EditorHost } from '../host'
import { journalPath, listJournals, loadProjectFile, saveProjectFile, writeAtomic } from '../project-file'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-host-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('project files', () => {
  it('writes atomically and leaves no temp files', async () => {
    const p = join(dir, 'a', 'x.json')
    await writeAtomic(p, 'one')
    await writeAtomic(p, 'two')
    expect(await fs.readFile(p, 'utf8')).toBe('two')
    expect(readdirSync(join(dir, 'a'))).toEqual(['x.json'])
  })

  it('finds moved media next to the project file', async () => {
    const host = new EditorHost({ dataDir: join(dir, 'data') })
    const { projectId } = host.create('Moved')
    host.execute(projectId, 'media.import', { path: 'D:/gone/clip.mp4', info: { duration: 2, hasVideo: true } })
    host.execute(projectId, 'media.import', { path: 'D:/gone/missing.mp4', info: { duration: 2, hasVideo: true } })
    await fs.writeFile(join(dir, 'clip.mp4'), '')
    const file = join(dir, 'p.tdproj')
    await saveProjectFile(file, host.session(projectId)!.project)
    const loaded = await loadProjectFile(file)
    const media = Object.values(loaded.project.items).filter((i) => i.kind === 'media')
    expect(media.find((m) => m.name === 'clip.mp4')).toMatchObject({ path: join(dir, 'clip.mp4') })
    expect(loaded.missing).toHaveLength(1)
    await host.shutdown()
  })
})

describe('editor host', () => {
  it('broadcasts patches a renderer mirror can follow', async () => {
    const host = new EditorHost({ dataDir: dir })
    const snap = host.create('Mirror')
    let mirror: Project = JSON.parse(JSON.stringify(snap.project))
    let version = snap.version
    const events: EditorChangeEvent[] = []
    host.onChange((e) => {
      events.push(e)
      const next = applyPatch(mirror, version, structuredClone(e.patch))
      expect(next).not.toBeNull()
      mirror = next!
      version = e.version
    })
    host.execute(snap.projectId, 'sequence.create', { name: 'S' })
    host.execute(snap.projectId, 'bin.create', { name: 'B' })
    host.undo(snap.projectId)
    expect(events.map((e) => e.source)).toEqual(['execute', 'execute', 'undo'])
    expect(events.at(-1)).toMatchObject({ dirty: true, canRedo: true, redoLabel: 'New Bin' })
    expect(mirror).toEqual(host.session(snap.projectId)!.project)
    await host.close(snap.projectId, { discard: true })
  })

  it('saves, journals unsaved edits, and recovers them after a crash', async () => {
    const host = new EditorHost({ dataDir: dir })
    const { projectId } = host.create('Crashy')
    const file = join(dir, 'crashy.tdproj')
    await host.save(projectId, file)
    expect(existsSync(journalPath(dir, projectId))).toBe(false)
    host.execute(projectId, 'sequence.create', { name: 'Unsaved work' })
    // the journal lands about a second after the edit
    await new Promise((r) => setTimeout(r, 1300))
    expect(existsSync(journalPath(dir, projectId))).toBe(true)
    // simulate a crash: a fresh host on the same data folder
    const after = new EditorHost({ dataDir: dir })
    const rec = await after.recoverable()
    expect(rec).toMatchObject([{ projectId, name: 'Crashy', filePath: file }])
    const snap = await after.recover(projectId)
    expect(snap.dirty).toBe(true)
    expect(Object.values(snap.project.items).some((i) => i.name === 'Unsaved work')).toBe(true)
    await after.save(projectId)
    expect(await listJournals(dir)).toEqual([])
    const reopened = await loadProjectFile(file)
    expect(Object.values(reopened.project.items).some((i) => i.name === 'Unsaved work')).toBe(true)
    await host.close(projectId, { discard: true })
    await after.shutdown()
  })

  it('refuses to close with unsaved changes', async () => {
    const host = new EditorHost({ dataDir: dir })
    const { projectId } = host.create()
    host.execute(projectId, 'bin.create', { name: 'x' })
    await expect(host.close(projectId)).rejects.toThrow(/unsaved/)
    await host.close(projectId, { discard: true })
  })

  it('agent tools import only shared library media and checkpoint whole turns', async () => {
    const host = new EditorHost({
      dataDir: dir,
      resolveLibraryItem: async (id) => (id === 'secret' ? { path: 'C:/x.mp4', name: 'x', agentAllowed: false } : null)
    })
    const { projectId } = host.create()
    const tools = host.toolHandler()
    expect(await tools('command_run', { id: 'media.import', args: { path: 'C:/Windows/win.ini' } })).toMatchObject({ ok: false, error: expect.stringMatching(/libraryId/) })
    expect(await tools('command_run', { id: 'media.import', args: { libraryId: 'secret' } })).toMatchObject({ ok: false, error: expect.stringMatching(/not shared/) })
    expect(await tools('command_run', { id: 'media.relink', args: { mediaId: 'm', path: 'C:/x' } })).toMatchObject({ ok: false })
    const cp = host.beginAgentTurn(projectId, 'Agent turn')
    await tools('command_run', { id: 'sequence.create', args: { name: 'A' } })
    await tools('command_run', { id: 'bin.create', args: { name: 'B' } })
    host.endAgentTurn(projectId)
    expect(host.session(projectId)!.history().undo.at(-1)).toBe('Agent turn')
    host.revert(projectId, cp)
    expect(Object.keys(host.session(projectId)!.project.items)).toEqual([])
    await host.close(projectId, { discard: true })
  })
})
