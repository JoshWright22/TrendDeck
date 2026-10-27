import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_CONFIG_EVENT } from '../../shared/dictation'
import { ToolError, type Turn } from '../gateway/types'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  installed: new Set<string>(),
  download: vi.fn(),
  downloading: [] as { id: string; dtype: string; received: number; total: number }[],
  gpu: {} as unknown,
  features: {} as Record<string, string>,
  accel: true,
  tools: [] as (() => unknown[])[]
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test-user-data',
    getGPUInfo: async () => mocks.gpu,
    getGPUFeatureStatus: () => mocks.features,
    isHardwareAccelerationEnabled: () => mocks.accel
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: vi.fn(), decryptString: vi.fn() }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => mocks.files.has(path),
  mkdirSync: vi.fn(),
  readFileSync: (path: string) => mocks.files.get(path),
  writeFileSync: (path: string, value: string) => mocks.files.set(path, value),
  renameSync: (from: string, to: string) => { mocks.files.set(to, mocks.files.get(from)!); mocks.files.delete(from) }
}))

vi.mock('../gateway/call', () => ({ registerToolSource: (fn: () => unknown[]) => mocks.tools.push(fn) }))

vi.mock('./models', async () => {
  const { localModel, LOCAL_MODELS } = await import('../../shared/dictation')
  const installedDtypes = (id: string): string[] => [...mocks.installed].filter((k) => k.startsWith(`${id}/`)).map((k) => k.split('/')[1])
  return {
    findModel: (id: unknown) => localModel(id),
    customModels: () => [],
    isInstalled: (id: string, dtype: string) => mocks.installed.has(`${id}/${dtype}`),
    installedDtypes,
    modelsState: async () => ({
      models: LOCAL_MODELS.map((m) => ({ id: m.id, installed: installedDtypes(m.id), downloading: mocks.downloading.filter((d) => d.id === m.id) })),
      diskBytes: 0
    }),
    downloadModel: mocks.download,
    deleteModel: vi.fn(),
    cancelDownload: vi.fn(),
    addCustomModel: vi.fn(),
    removeCustomModel: vi.fn()
  }
})

import { setupDictation } from './index'
import { DICTATION_TOOLS, setupDictationModel } from './tools'

const turn = { brandId: 'b' } as unknown as Turn
const tool = (name: string) => DICTATION_TOOLS.find((t) => t.name === name)!
const configPath = (): string => [...mocks.files.keys()].find((k) => k.endsWith('config.json'))!
const savedSource = (): string => (configPath() ? JSON.parse(mocks.files.get(configPath())!).options.source : 'nothing saved')

let sender: EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
let dispose: () => void

function nvidia(): void {
  mocks.gpu = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2786, deviceString: 'NVIDIA GeForce RTX 4070', driverVersion: '32.0.15.6094' }] }
  mocks.features = { webgpu: 'enabled', gpu_compositing: 'enabled' }
}

beforeEach(() => {
  mocks.files.clear()
  mocks.installed.clear()
  mocks.download.mockReset()
  mocks.downloading = []
  mocks.accel = true
  nvidia()
  sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false })
  dispose = setupDictation(window as unknown as BrowserWindow, 'file:///app/index.html')
})

afterEach(() => {
  dispose()
  vi.useRealTimers()
})

describe('dictation tools', () => {
  it('are registered with the gateway once, a read and an edit', () => {
    expect(mocks.tools).toHaveLength(1)
    expect(mocks.tools[0]().map((t) => (t as { name: string }).name)).toEqual(['dictation_status', 'dictation_setup'])
    expect(tool('dictation_status').risk).toBe('read')
    expect(tool('dictation_setup').risk).toBe('edit')
  })

  it('status shows the GPU, models and configured providers without ids, values or keys', async () => {
    // a server on this computer with its address, and OpenAI saved without a key
    mocks.files.set(join('/test-user-data', 'dictation', 'config.json'), JSON.stringify({
      version: 2,
      options: { source: 'local:whisper-base', localPrefs: {}, language: '', autoSend: false, autoSendPauseMs: 1500, holdKey: 'Ctrl+Space', handsFree: false },
      providers: [
        { id: 'srv1', providerId: 'whisper-cpp', label: 'whisper.cpp', values: { baseUrl: 'http://127.0.0.1:8181' }, secrets: {}, model: 'loaded' },
        { id: 'oai1', providerId: 'openai', label: 'OpenAI', values: {}, secrets: { apiKey: '' }, model: 'whisper-1' }
      ]
    }))
    mocks.installed.add('whisper-base/q8')
    mocks.downloading = [{ id: 'whisper-small', dtype: 'q8', received: 50, total: 200 }]
    const status = (await tool('dictation_status').run(turn, {})) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(status.gpu).toEqual({
      inUse: 'NVIDIA GeForce RTX 4070 (NVIDIA)', kind: 'discrete', driver: '32.0.15.6094', others: [], webgpu: 'available', hardwareAcceleration: 'on'
    })
    expect(status.activeSource).toEqual({ kind: 'local model', name: 'Whisper Base' })
    const base = status.localModels.find((m: { id: string }) => m.id === 'whisper-base')
    expect(base).toMatchObject({ downloaded: 'yes', active: 'yes', downloadSize: '139 MB' })
    expect(status.localModels.find((m: { id: string }) => m.id === 'whisper-small').downloaded).toBe('downloading, 25%')
    expect(status.localModels.find((m: { id: string }) => m.id === 'whisper-large-v3-turbo').downloaded).toBe('no')
    expect(status.providers.find((p: { name: string }) => p.name === 'whisper.cpp server' || p.name === 'whisper.cpp')).toMatchObject({ configured: 'yes' })
    expect(status.providers.find((p: { name: string }) => p.name === 'OpenAI')).toMatchObject({ configured: 'no' })
    expect(status.recommended.model).toBe('whisper-large-v3-turbo')
    const text = JSON.stringify(status)
    expect(text).not.toMatch(/127\.0\.0\.1|8181|0x2786|10118|srv1|oai1|apiKey/)
  })

  it('setup with no model downloads the best one for the GPU and makes it the source', async () => {
    mocks.download.mockImplementation(async (id: string, dtype: string, progress: (p: unknown) => void) => {
      progress({ id, dtype, state: 'done', received: 1, total: 1 })
      mocks.installed.add(`${id}/${dtype}`)
    })
    const out = await setupDictationModel({})
    expect(mocks.download).toHaveBeenCalledWith('whisper-large-v3-turbo', 'q4', expect.any(Function))
    expect(out).toMatch(/^Downloaded Whisper Large v3 Turbo \(\d+ MB\) and made it the dictation source\. NVIDIA GeForce RTX 4070 is a dedicated/)
    expect(savedSource()).toBe('local:whisper-large-v3-turbo')
    // the window hears about the progress and the new source
    expect(sender.send).toHaveBeenCalledWith('dictation:model-progress', expect.objectContaining({ state: 'done' }))
    expect(sender.send).toHaveBeenCalledWith(DICTATION_CONFIG_EVENT, expect.objectContaining({ source: 'local:whisper-large-v3-turbo' }))
  })

  it('setup picks Base without WebGPU', async () => {
    mocks.features = { webgpu: 'disabled_off', gpu_compositing: 'enabled' }
    mocks.download.mockImplementation(async (id: string, dtype: string) => { mocks.installed.add(`${id}/${dtype}`) })
    await setupDictationModel({})
    expect(mocks.download).toHaveBeenCalledWith('whisper-base', 'q8', expect.any(Function))
    expect(savedSource()).toBe('local:whisper-base')
  })

  it('setup switches to a model that is already downloaded without downloading', async () => {
    mocks.installed.add('whisper-small/fp16')
    const out = await setupDictationModel({ model: 'whisper-small' })
    expect(mocks.download).not.toHaveBeenCalled()
    expect(out).toBe('Whisper Small was already downloaded and is now the dictation source.')
    expect(savedSource()).toBe('local:whisper-small')
    expect(JSON.parse(mocks.files.get(configPath())!).options.localPrefs['whisper-small'].dtype).toBe('fp16')
    expect(await setupDictationModel({ model: 'local:whisper-small' })).toBe('Whisper Small is already downloaded and is the dictation source.')
  })

  it('setup refuses unknown models and providers', async () => {
    await expect(setupDictationModel({ model: 'whisper-huge' })).rejects.toThrow(ToolError)
    await expect(setupDictationModel({ model: 'whisper-huge' })).rejects.toThrow(/no local model called whisper-huge\. models: whisper-tiny,/)
    await expect(setupDictationModel({ model: 'openai' })).rejects.toThrow(/only sets up local models/)
    await expect(setupDictationModel({ model: 'provider:abc' })).rejects.toThrow(/only sets up local models/)
    await expect(setupDictationModel({ model: '../../etc' })).rejects.toThrow(/no local model/)
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('setup says a slow download is still going, and sets the source when it lands', async () => {
    let finish!: () => void
    mocks.download.mockImplementation((id: string, dtype: string) => new Promise<void>((resolve) => {
      finish = () => { mocks.installed.add(`${id}/${dtype}`); resolve() }
    }))
    mocks.downloading = [{ id: 'whisper-medium', dtype: 'q4', received: 300_000_000, total: 680_000_000 }]
    const out = await setupDictationModel({ model: 'whisper-medium' }, 10)
    expect(out).toMatch(/^Whisper Medium \(\d+ MB\) is still downloading, 300 MB of 680 MB so far\. It becomes the dictation source by itself when it finishes\./)
    expect(savedSource()).not.toBe('local:whisper-medium')
    finish()
    await vi.waitFor(() => expect(savedSource()).toBe('local:whisper-medium'))
  })

  it('a late download does not override a source the user picked meanwhile', async () => {
    let finish!: () => void
    mocks.download.mockImplementation((id: string, dtype: string) => new Promise<void>((resolve) => {
      finish = () => { mocks.installed.add(`${id}/${dtype}`); resolve() }
    }))
    await setupDictationModel({ model: 'whisper-medium' }, 10)
    mocks.installed.add('moonshine-base/q8')
    await setupDictationModel({ model: 'moonshine-base' })
    finish()
    await new Promise((r) => setTimeout(r, 10))
    expect(savedSource()).toBe('local:moonshine-base')
  })

  it('setup reports a failed download plainly', async () => {
    mocks.download.mockRejectedValue(new Error('Download failed. Check your connection and try again.'))
    await expect(setupDictationModel({ model: 'whisper-tiny' })).rejects.toThrow('Whisper Tiny could not be downloaded: Download failed. Check your connection and try again.')
  })

  it('the approval line names the model and size', async () => {
    const setup = tool('dictation_setup')
    expect(await setup.summarize!(turn, {})).toMatch(/^Download Whisper Large v3 Turbo \(\d+ MB\) and use it for dictation$/)
    mocks.installed.add('whisper-base/q8')
    expect(await setup.summarize!(turn, { model: 'whisper-base' })).toBe('Use Whisper Base for dictation')
    expect(await setup.summarize!(turn, { model: 'nope' })).toBe('Set up dictation')
  })
})
