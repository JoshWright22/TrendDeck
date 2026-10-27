import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  children: [] as (EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> })[],
  askClose: vi.fn(), release: vi.fn(), setLive: vi.fn()
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  return { spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
    mocks.children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  } }
})
vi.mock('../dock', () => ({ askClose: mocks.askClose, release: mocks.release, attach: vi.fn(), forget: vi.fn() }))
vi.mock('../install', () => ({ installed: async () => ({ exe: 'test-editor' }), applyStaged: vi.fn() }))
vi.mock('../state', () => ({ setLive: mocks.setLive }))

let root: string
let lifecycle: typeof import('../launch')

beforeEach(async () => {
  vi.resetModules()
  mocks.children.length = 0
  mocks.askClose.mockReset().mockReturnValue(false)
  mocks.release.mockReset()
  mocks.setLive.mockReset()
  root = await fs.mkdtemp(join(tmpdir(), 'craft-launch-save-'))
  lifecycle = await import('../launch')
})

afterEach(async () => {
  for (const child of mocks.children) child.emit('exit')
  await fs.rm(root, { recursive: true, force: true })
})

async function launch(): Promise<import('../launch').Running> {
  const file = join(root, 'main.fcproj')
  await fs.writeFile(file, 'original before manual editing')
  return lifecycle.launch({ appId: 'filmcraft', brandId: 'brand', projectId: 'project', folder: root, file })
}

describe('safe Craft window lifecycle', () => {
  it('preserves the project before starting a manual editor', async () => {
    await launch()
    const directory = join(root, '.trenddeck', 'autosaves')
    const [entry] = await fs.readdir(directory)
    expect(await fs.readFile(join(directory, entry, 'main.fcproj'), 'utf8')).toBe('original before manual editing')
    expect(mocks.setLive.mock.calls.at(-1)![1].autosave).toMatchObject({ state: 'unavailable', savedAt: null })
  })

  it('never kills the editor when no closeable window is found', async () => {
    const run = await launch()
    expect(await lifecycle.close('filmcraft', 1)).toBe(false)
    expect(run.child.kill).not.toHaveBeenCalled()
    expect(lifecycle.runningApp('filmcraft')).toBe(run)
  })

  it('does not even request close when live preservation fails', async () => {
    const run = await launch()
    lifecycle.onBeforeAppClose(async () => { throw new Error('save failed') })
    await expect(lifecycle.close('filmcraft', 1)).rejects.toThrow('save failed')
    expect(mocks.askClose).not.toHaveBeenCalled()
    expect(run.child.kill).not.toHaveBeenCalled()
  })

  it('leaves native save dialogs alone after a close timeout', async () => {
    const run = await launch()
    const save = vi.fn().mockResolvedValue(undefined)
    lifecycle.onBeforeAppClose(save)
    mocks.askClose.mockReturnValue(true)
    expect(await lifecycle.close('filmcraft', 1)).toBe(false)
    expect(save).toHaveBeenCalledWith(run)
    expect(mocks.askClose).toHaveBeenCalledWith(run.pid)
    expect(run.child.kill).not.toHaveBeenCalled()
    expect(lifecycle.runningApp('filmcraft')).toBe(run)
  })

  it('finishes a normal close after saving and a real exit', async () => {
    await launch()
    lifecycle.onBeforeAppClose(async () => {})
    mocks.askClose.mockImplementation(() => { queueMicrotask(() => mocks.children[0].emit('exit')); return true })
    expect(await lifecycle.close('filmcraft', 1000)).toBe(true)
    expect(lifecycle.runningApp('filmcraft')).toBeNull()
    expect(mocks.setLive.mock.calls.at(-1)![1]).toMatchObject({ running: false, autosave: undefined })
  })

  it('keeps all editors docked when any quit autosave fails', async () => {
    await launch()
    await lifecycle.launch({ appId: 'photocraft', brandId: 'brand', projectId: 'other', folder: root, file: null })
    lifecycle.onBeforeAppClose(async (run) => { if (run.appId === 'photocraft') throw new Error('save failed') })
    await expect(lifecycle.closeAllForQuit(1)).rejects.toThrow('save failed')
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.askClose).not.toHaveBeenCalled()
    for (const child of mocks.children) expect(child.kill).not.toHaveBeenCalled()
  })

  it('waits for every quit autosave before releasing windows and requests native close only once', async () => {
    await launch()
    await lifecycle.launch({ appId: 'photocraft', brandId: 'brand', projectId: 'other', folder: root, file: null })
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const saved: string[] = []
    const save = vi.fn(async (run: import('../launch').Running) => {
      if (run.appId === 'photocraft') await gate
      saved.push(run.appId)
    })
    lifecycle.onBeforeAppClose(save)
    mocks.askClose.mockReturnValue(true)
    const closing = lifecycle.closeAllForQuit(1)
    await vi.waitFor(() => expect(saved).toEqual(['filmcraft']))
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.askClose).not.toHaveBeenCalled()
    release()
    await closing
    expect(saved).toEqual(['filmcraft', 'photocraft'])
    expect(save).toHaveBeenCalledTimes(2)
    expect(mocks.release).toHaveBeenCalledTimes(2)
    expect(mocks.askClose).toHaveBeenCalledTimes(2)
  })
})
