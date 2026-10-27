import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Running } from '../launch'

const mocks = vi.hoisted(() => ({
  call: vi.fn(), close: vi.fn(), run: null as Running | null,
  setLive: vi.fn(),
  inspect: vi.fn(), tools: vi.fn(), activePath: '',
  connectionExit: null as ((why: string) => void) | null,
  beforeClose: null as ((run: Running) => Promise<void>) | null,
  start: null as ((run: Running) => void) | null,
  exit: null as ((run: Running) => void) | null
}))

vi.mock('../install', () => ({ installed: async (appId: string) => ({ cli: 'test-cli', dir: '.', version: appId === 'filmcraft' ? '0.13.0' : '0.16.0' }), craftRoot: () => '.' }))
vi.mock('../launch', () => ({
  cleanEnv: () => ({}), runningApp: () => mocks.run,
  onBeforeAppClose: (hook: typeof mocks.beforeClose) => { mocks.beforeClose = hook },
  onAppStart: (hook: typeof mocks.start) => { mocks.start = hook },
  onAppExit: (hook: typeof mocks.exit) => { mocks.exit = hook }
}))
vi.mock('../paths', () => ({ appFiles: async () => [] }))
vi.mock('../state', () => ({ setLive: mocks.setLive, changed: vi.fn() }))
vi.mock('../mcp', () => ({ McpClient: class {
  start = async (): Promise<void> => {}
  listTools = mocks.tools
  callTool = (name: string, ...args: unknown[]): Promise<unknown> => name === 'project_inspect' || name === 'doc_inspect' ? mocks.inspect(name, ...args) : mocks.call(name, ...args)
  close = mocks.close
  onExit = (hook: (why: string) => void): void => { mocks.connectionExit = hook }
} }))

let root: string
let file: string
let agent: typeof import('../agent')

beforeEach(async () => {
  vi.resetModules()
  mocks.run = null
  mocks.call.mockReset().mockResolvedValue({ content: [] })
  mocks.close.mockReset()
  mocks.setLive.mockReset()
  root = await fs.mkdtemp(join(tmpdir(), 'craft-agent-save-'))
  file = join(root, 'main.fcproj')
  mocks.activePath = file
  mocks.inspect.mockReset().mockImplementation(async () => ({ content: [{ type: 'text', text: JSON.stringify({ path: mocks.activePath }) }] }))
  mocks.tools.mockReset().mockResolvedValue([
    { name: 'project_inspect', annotations: { readOnlyHint: true } }, { name: 'command_run' },
    { name: 'doc_inspect', annotations: { readOnlyHint: true } }, { name: 'doc_save' }
  ])
  await fs.writeFile(file, 'original')
  agent = await import('../agent')
})

afterEach(async () => {
  await agent.stopSession('filmcraft', false)
  await agent.stopSession('photocraft', false)
  await agent.stopSession('lightcraft', false)
  await agent.stopSession('pdfcraft', false)
  await fs.rm(root, { recursive: true, force: true })
})

async function session(bridge = false): Promise<import('../agent').Session> {
  if (bridge) mocks.run = { appId: 'filmcraft', brandId: 'brand', projectId: 'project', folder: root, file } as Running
  return agent.sessionFor('filmcraft', 'brand', 'project', root, async () => file, false)
}

async function copies(): Promise<string[]> {
  const directory = join(root, '.trenddeck', 'autosaves')
  const entries = await fs.readdir(directory)
  return Promise.all(entries.map((entry) => fs.readFile(join(directory, entry, 'main.fcproj'), 'utf8')))
}

describe('Craft session saving', () => {
  it('refuses a mismatched active document before writing snapshots, saving, editing or closing', async () => {
    const live = await session(true)
    await agent.saveSession('filmcraft')
    const before = await copies()
    mocks.call.mockClear()
    const other = join(root, 'other.fcproj')
    await fs.writeFile(other, 'other original')
    mocks.activePath = other
    await expect(agent.saveSession('filmcraft')).rejects.toThrow('could not be verified')
    expect(await copies()).toEqual(before)
    expect(await fs.readFile(file, 'utf8')).toBe('original')
    expect(await fs.readFile(other, 'utf8')).toBe('other original')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
    const edit = vi.fn()
    await expect(agent.sessionCall(live, true, edit)).rejects.toThrow('could not be verified')
    expect(edit).not.toHaveBeenCalled()
    agent.setupAgentSessions()
    await expect(mocks.beforeClose!(mocks.run!)).rejects.toThrow('could not be verified')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it.each(['missing path', 'failed inspection', 'inspection error'])('fails closed for %s without exposing inspection details', async (problem) => {
    await session(true)
    if (problem === 'missing path') mocks.inspect.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ name: 'main.fcproj', root: file }) }] })
    else if (problem === 'failed inspection') mocks.inspect.mockRejectedValue(new Error(`private path ${file}`))
    else mocks.inspect.mockResolvedValue({ isError: true, content: [{ type: 'text', text: file }] })
    await expect(agent.saveSession('filmcraft')).rejects.toThrow('could not be verified')
    expect(mocks.call).not.toHaveBeenCalled()
    const status = mocks.setLive.mock.calls.at(-1)![1].autosave
    expect(status).toMatchObject({ state: 'unavailable', savedAt: null })
    expect(status.note).not.toContain(file)
    await expect(fs.access(join(root, '.trenddeck', 'autosaves'))).rejects.toThrow()
  })

  it('uses PhotoCraft pathless bridge saves and rejects path-targeted saves even on the non-edit call route', async () => {
    mocks.run = { appId: 'photocraft', brandId: 'brand', projectId: 'project', folder: root, file } as Running
    const live = await agent.sessionFor('photocraft', 'brand', 'project', root, async () => file, false)
    await agent.saveSession('photocraft')
    expect(mocks.call).toHaveBeenCalledWith('doc_save', {}, { timeoutMs: 60_000 })
    expect(mocks.call.mock.calls.every(([, args]) => !('path' in args) && !('index' in args))).toBe(true)
    const save = vi.fn()
    await expect(agent.sessionCall(live, false, save, { tool: 'doc_save', args: { path: file } })).rejects.toThrow('could not be verified')
    expect(save).not.toHaveBeenCalled()
  })

  it('does not save or advertise live autosave when the bridge lacks verified inspection capabilities', async () => {
    mocks.tools.mockResolvedValue([{ name: 'command_run' }])
    await session(true)
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable' })
    await expect(agent.saveSession('filmcraft')).rejects.toThrow('could not be verified')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('detects a document switch during a pathless save and does not attribute a snapshot to the wrong document', async () => {
    await session(true)
    const other = join(root, 'other.fcproj')
    await fs.writeFile(other, 'other')
    mocks.call.mockImplementationOnce(async () => { mocks.activePath = other; return { content: [] } })
    await expect(agent.saveSession('filmcraft')).rejects.toThrow('could not be verified')
    expect(mocks.call).toHaveBeenCalledWith('command_run', { id: 'file.save', params: {} }, { timeoutMs: 60_000 })
    expect(await copies()).toEqual(['original'])
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
  })

  it('refuses agent document switches and Save As rather than guessing a new session path', async () => {
    const live = await session(true)
    const change = vi.fn()
    await expect(agent.sessionCall(live, true, change, { tool: 'command_run', args: { id: 'file.saveAs', params: { path: join(root, 'other.fcproj') } } })).rejects.toThrow('Changing documents')
    expect(change).not.toHaveBeenCalled()
    expect(live.file).toBe(file)
    await agent.stopSession('filmcraft', false)
    mocks.run = { appId: 'photocraft', brandId: 'brand', projectId: 'project', folder: root, file } as Running
    const photo = await agent.sessionFor('photocraft', 'brand', 'project', root, async () => file, false)
    await expect(agent.sessionCall(photo, true, change, { tool: 'doc_open', args: { path: join(root, 'other.pcraft') } })).rejects.toThrow('Changing documents')
    expect(change).not.toHaveBeenCalled()
    expect(photo.file).toBe(file)
  })

  it('permits ordinary edits for apps without any generic save capability, without advertising autosave', async () => {
    mocks.run = { appId: 'lightcraft', brandId: 'brand', projectId: 'project', folder: root, file } as Running
    const live = await agent.sessionFor('lightcraft', 'brand', 'project', root, async () => file, false)
    const edit = vi.fn().mockResolvedValue('edited')
    await expect(agent.sessionCall(live, true, edit, { tool: 'adjust_exposure', args: {} })).resolves.toBe('edited')
    expect(edit).toHaveBeenCalledOnce()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable' })
    mocks.run = null
    const headless = await agent.sessionFor('pdfcraft', 'brand', 'project', root, async () => file, false)
    await expect(agent.sessionCall(headless, true, edit, { tool: 'page_rotate', args: {} })).resolves.toBe('edited')
  })

  it('reports ready, saving and verified saved states for a live bridge without exposing paths', async () => {
    await session(true)
    expect(mocks.setLive).toHaveBeenLastCalledWith('filmcraft', { autosave: { state: 'ready', savedAt: null, note: expect.any(String) } })
    mocks.call.mockImplementationOnce(async () => {
      expect(mocks.setLive).toHaveBeenLastCalledWith('filmcraft', { autosave: { state: 'saving', savedAt: null, note: expect.any(String) } })
      return { content: [] }
    })
    const before = Date.now()
    await agent.saveSession('filmcraft')
    const result = mocks.setLive.mock.calls.at(-1)![1].autosave
    expect(result.state).toBe('saved')
    expect(result.savedAt).toBeGreaterThanOrEqual(before)
    expect(result.note).not.toContain(root)
    agent.markDirty('filmcraft')
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'ready', savedAt: result.savedAt })
  })

  it('reports generic actionable errors and preserves the timestamp of the last verified save', async () => {
    await session(true)
    await agent.saveSession('filmcraft')
    const lastSaved = mocks.setLive.mock.calls.at(-1)![1].autosave.savedAt
    mocks.call.mockRejectedValueOnce(new Error(`Private failure at ${file}`))
    await expect(agent.saveSession('filmcraft')).rejects.toThrow('Private failure')
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toEqual({
      state: 'error', savedAt: lastSaved, note: 'Autosave failed. Save in the editor and try again; TrendDeck has not closed it.'
    })
  })

  it('never reports headless saves as live editor saves and clears status on stop', async () => {
    await session()
    agent.markDirty('filmcraft')
    await agent.saveSession('filmcraft')
    expect(mocks.setLive.mock.calls.some(([, patch]) => ['ready', 'saving', 'saved'].includes(patch.autosave?.state))).toBe(false)
    await agent.stopSession('filmcraft')
    expect(mocks.setLive).toHaveBeenLastCalledWith('filmcraft', { agent: 'off', autosave: undefined })
  })

  it('clears saved state on disconnect and returns to ready after reconnecting', async () => {
    await session(true)
    await agent.saveSession('filmcraft')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.connectionExit!('closed')
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
    await session(true)
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'ready', savedAt: null })
    logged.mockRestore()
  })

  it('reports unavailable when a bridge has no known file or catalog save support', async () => {
    mocks.run = { appId: 'filmcraft', brandId: 'brand', projectId: 'project', folder: root, file: null } as Running
    await agent.sessionFor('filmcraft', 'brand', 'project', root, async () => null, false)
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
    await agent.stopSession('filmcraft', false)
    mocks.run = { ...mocks.run, appId: 'lightcraft', file } as Running
    await agent.sessionFor('lightcraft', 'brand', 'project', root, async () => file, false)
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
    await agent.stopSession('lightcraft', false)
  })

  it('saves the actual bridge even with no agent dirty flag, preserving disk and live copies', async () => {
    const live = await session(true)
    mocks.call.mockImplementation(async () => { await fs.writeFile(file, 'live user changes'); return { content: [] } })
    expect(live.dirty).toBe(false)
    await agent.saveSession('filmcraft')
    expect(mocks.call).toHaveBeenCalledWith('command_run', { id: 'file.save', params: {} }, { timeoutMs: 60_000 })
    expect(await copies()).toEqual(expect.arrayContaining(['original', 'live user changes']))
    expect(live.dirty).toBe(false)
  })

  it('keeps a dirty headless engine connected on save failure, and succeeds on retry', async () => {
    const headless = await session()
    agent.markDirty('filmcraft')
    mocks.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'save rejected' }] })
    await expect(agent.stopSession('filmcraft')).rejects.toThrow('save rejected')
    expect(agent.sessionOf('filmcraft')).toBe(headless)
    expect(headless.dirty).toBe(true)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(await copies()).toContain('original')
    await agent.stopSession('filmcraft')
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(agent.sessionOf('filmcraft')).toBeNull()
  })

  it('preserves live work before agent edits and serializes an autosave behind the edit', async () => {
    const live = await session(true)
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    let edited = false
    const edit = agent.sessionCall(live, true, async () => { edited = true; await gate; return 'done' })
    await vi.waitFor(() => expect(edited).toBe(true))
    expect(await copies()).toContain('original')
    const save = agent.saveSession('filmcraft')
    await new Promise((done) => setTimeout(done, 10))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    release()
    expect(await edit).toBe('done')
    await save
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(live.dirty).toBe(false)
  })

  it('refuses editing when preservation fails and conservatively tracks partial edits', async () => {
    const live = await session(true)
    const edit = vi.fn().mockRejectedValue(new Error('partial tool failure'))
    mocks.call.mockResolvedValueOnce({ isError: true, content: [] })
    await expect(agent.sessionCall(live, true, edit)).rejects.toThrow('save')
    expect(edit).not.toHaveBeenCalled()
    await expect(agent.sessionCall(live, true, edit)).rejects.toThrow('partial tool failure')
    expect(live.dirty).toBe(true)
  })

  it('does not close the bridge or proceed with close after a failed live save', async () => {
    const live = await session(true)
    agent.setupAgentSessions()
    mocks.call.mockRejectedValueOnce(new Error('bridge offline'))
    await expect(mocks.beforeClose!(mocks.run!)).rejects.toThrow('bridge offline')
    expect(agent.sessionOf('filmcraft')).toBe(live)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('keeps headless saving conditional on dirty state', async () => {
    await session()
    await agent.saveSession('filmcraft')
    expect(mocks.call).not.toHaveBeenCalled()
    agent.markDirty('filmcraft')
    await agent.saveSession('filmcraft')
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('reuses one headless engine when concurrent callers request the same session', async () => {
    const [first, second] = await Promise.all([session(), session()])
    expect(first).toBe(second)
    agent.markDirty('filmcraft')
    await agent.saveSession('filmcraft')
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('does not clear dirty state or close after the post-save snapshot cannot be verified', async () => {
    const headless = await session()
    agent.markDirty('filmcraft')
    mocks.call.mockImplementationOnce(async () => { await fs.unlink(file); return { content: [] } })
    await expect(agent.stopSession('filmcraft')).rejects.toThrow()
    expect(headless.dirty).toBe(true)
    expect(agent.sessionOf('filmcraft')).toBe(headless)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(await copies()).toContain('original')
  })

  it('reports unavailable rather than saved when the active file disappears during a live save', async () => {
    await session(true)
    mocks.call.mockImplementationOnce(async () => { await fs.unlink(file); return { content: [] } })
    await expect(agent.saveSession('filmcraft')).rejects.toThrow()
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
  })
  it('stops an edited session of an app TrendDeck cannot autosave instead of failing forever', async () => {
    const headless = await agent.sessionFor('pdfcraft', 'brand', 'project', root, async () => file, false)
    await agent.sessionCall(headless, true, async () => 'edited', { tool: 'page_rotate', args: {} })
    expect(headless.dirty).toBe(true)
    mocks.call.mockClear()
    await expect(agent.stopSession('pdfcraft')).resolves.toBeUndefined()
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.run = { appId: 'lightcraft', brandId: 'brand', projectId: 'project', folder: root, file } as Running
    const live = await agent.sessionFor('lightcraft', 'brand', 'project', root, async () => file, false)
    await agent.sessionCall(live, true, async () => 'edited', { tool: 'adjust_exposure', args: {} })
    mocks.call.mockClear()
    await expect(agent.stopSession('lightcraft')).resolves.toBeUndefined()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('lets an app without a verified live save close with its own save prompt', async () => {
    agent.setupAgentSessions()
    mocks.tools.mockResolvedValue([{ name: 'project_inspect', annotations: { readOnlyHint: true } }])
    await session(true)
    await expect(mocks.beforeClose!(mocks.run!)).resolves.toBeUndefined()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

