import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTATION_OPTIONS, DICTATION_CHANNELS, DICTATION_PROGRESS_EVENT, DICTATION_TIMEOUT_MS } from '../../shared/dictation'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  encryptionAvailable: true,
  encrypt: vi.fn((key: string) => Buffer.from(`encrypted:${key.split('').reverse().join('')}`)),
  decrypt: vi.fn((data: Buffer) => data.toString().slice(10).split('').reverse().join('')),
  download: vi.fn(),
  remove: vi.fn(),
  cancelDownload: vi.fn(),
  installed: new Set<string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test-user-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: mocks.encrypt,
    decryptString: mocks.decrypt
  }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => mocks.files.has(path),
  mkdirSync: vi.fn(),
  readFileSync: (path: string) => mocks.files.get(path),
  writeFileSync: (path: string, value: string) => mocks.files.set(path, value),
  renameSync: (from: string, to: string) => { mocks.files.set(to, mocks.files.get(from)!); mocks.files.delete(from) }
}))

vi.mock('./models', async () => {
  const { localModel } = await import('../../shared/dictation')
  return {
    findModel: (id: unknown) => localModel(id),
    customModels: () => [],
    isInstalled: (id: string, dtype: string) => mocks.installed.has(`${id}/${dtype}`),
    installedDtypes: (id: string) => [...mocks.installed].filter((k) => k.startsWith(`${id}/`)).map((k) => k.split('/')[1]),
    modelsState: async () => ({ models: [], diskBytes: 0 }),
    downloadModel: mocks.download,
    deleteModel: mocks.remove,
    cancelDownload: mocks.cancelDownload,
    addCustomModel: vi.fn(),
    removeCustomModel: vi.fn()
  }
})

import { setupDictation } from './index'

let dispose: () => void
let sender: EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
const fetchMock = vi.fn<typeof fetch>()
const audio = { bytes: new ArrayBuffer(4), mimeType: 'audio/webm;codecs=opus' }
const configFile = (): string => [...mocks.files.keys()].find((k) => k.endsWith('config.json'))!

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke(name: keyof typeof DICTATION_CHANNELS, ...args: unknown[]): any {
  return mocks.handlers.get(DICTATION_CHANNELS[name])!({ sender, senderFrame: sender.mainFrame }, ...args)
}

const later = (fn: () => unknown): Promise<unknown> => Promise.resolve().then(fn)

// OpenAI with a key, made the active source
function openaiConfig(): string {
  const config = invoke('saveProvider', { providerId: 'openai', values: { apiKey: 'private-api-key' }, model: 'whisper-1' })
  const id = config.providers.at(-1).id
  invoke('setSource', `provider:${id}`)
  return id
}

function localServer(baseUrl = 'http://localhost:8080/v1'): string {
  const config = invoke('saveProvider', { providerId: 'local-openai-compatible', values: { baseUrl }, model: 'whisper-1' })
  const id = config.providers.at(-1).id
  invoke('setSource', `provider:${id}`)
  return id
}

beforeEach(() => {
  mocks.files.clear()
  mocks.handlers.clear()
  mocks.encryptionAvailable = true
  mocks.encrypt.mockClear()
  mocks.decrypt.mockClear()
  mocks.download.mockReset()
  mocks.remove.mockReset()
  mocks.cancelDownload.mockReset()
  mocks.installed.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false })
  dispose = setupDictation(window as unknown as BrowserWindow, 'file:///app/index.html')
})

afterEach(() => {
  dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('dictation main process', () => {
  it('rejects webviews, child frames and navigated windows on every channel', async () => {
    for (const handler of mocks.handlers.values()) {
      await expect(later(() => handler({ sender: {}, senderFrame: sender.mainFrame }))).rejects.toThrow()
      await expect(later(() => handler({ sender, senderFrame: { url: sender.mainFrame.url } }))).rejects.toThrow()
    }
    sender.mainFrame.url = 'https://untrusted.example'
    expect(() => invoke('getConfig')).toThrow('Untrusted')
    await expect(later(() => invoke('downloadModel', 'whisper-base', 'q8'))).rejects.toThrow('Untrusted')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('starts on the default local model with no providers', () => {
    expect(invoke('getConfig')).toEqual({ ...DEFAULT_DICTATION_OPTIONS, providers: [], customModels: [] })
    expect(DEFAULT_DICTATION_OPTIONS).toMatchObject({ source: 'local:whisper-base', language: '', handsFree: false, autoSend: false })
  })

  it('saves partial option updates and refuses the source and unknown keys there', () => {
    expect(invoke('saveConfig', { handsFree: true })).toMatchObject({ handsFree: true, source: 'local:whisper-base' })
    expect(invoke('saveConfig', {
      holdKey: 'Alt+Space', autoSend: true, autoSendPauseMs: 2000, localPrefs: { 'whisper-small': { dtype: 'q4', device: 'webgpu' } }
    })).toMatchObject({
      holdKey: 'Alt+Space', autoSend: true, autoSendPauseMs: 2000, handsFree: true, localPrefs: { 'whisper-small': { dtype: 'q4', device: 'webgpu' } }
    })
    expect(() => invoke('saveConfig', { handsFree: 'yes' })).toThrow()
    expect(() => invoke('saveConfig', { secret: true })).toThrow('Unknown')
    expect(() => invoke('saveConfig', { source: 'local:whisper-tiny' })).toThrow('setSource')
    expect(() => invoke('saveConfig', { localPrefs: { 'whisper-base': { dtype: 'q9', device: 'auto' } } })).toThrow()
  })

  it('switches only to downloaded local models, using another download of the same model if needed', () => {
    expect(() => invoke('setSource', 'local:whisper-tiny')).toThrow('Download Whisper Tiny first')
    mocks.installed.add('whisper-tiny/q8')
    expect(invoke('setSource', 'local:whisper-tiny')).toMatchObject({ source: 'local:whisper-tiny' })
    invoke('saveConfig', { localPrefs: { 'whisper-small': { dtype: 'fp16', device: 'auto' } } })
    mocks.installed.add('whisper-small/q4')
    expect(invoke('setSource', 'local:whisper-small'))
      .toMatchObject({ source: 'local:whisper-small', localPrefs: { 'whisper-small': { dtype: 'q4', device: 'auto' } } })
    expect(() => invoke('setSource', 'local:whisper-huge')).toThrow()
    expect(() => invoke('setSource', 'provider:missing')).toThrow('not configured')
  })

  it('stores provider keys encrypted and only says whether one is saved', () => {
    openaiConfig()
    expect(mocks.encrypt).toHaveBeenCalledWith('private-api-key')
    expect([...mocks.files.values()].join('')).not.toContain('private-api-key')
    const config = invoke('getConfig')
    expect(config.providers).toEqual([{
      id: expect.any(String), providerId: 'openai', label: 'OpenAI', values: {}, hasSecret: { apiKey: true }, model: 'whisper-1',
      host: 'api.openai.com', kind: 'api'
    }])
    expect(JSON.stringify(config)).not.toContain('encrypted')
  })

  it('keeps a saved key on edit and drops it when the server address changes', () => {
    const config = invoke('saveProvider', { providerId: 'openai-compatible', values: { baseUrl: 'https://a.example/v1', apiKey: 'private-api-key' }, model: 'm' })
    const id = config.providers[0].id
    expect(invoke('saveProvider', { id, providerId: 'openai-compatible', values: { baseUrl: 'https://a.example/v1', apiKey: '' }, model: 'm2' }).providers[0])
      .toMatchObject({ model: 'm2', hasSecret: { apiKey: true } })
    expect(invoke('saveProvider', { id, providerId: 'openai-compatible', values: { baseUrl: 'https://b.example/v1' }, model: 'm2' }).providers[0])
      .toMatchObject({ host: 'b.example', hasSecret: { apiKey: false } })
    expect(() => invoke('saveProvider', { id, providerId: 'openai', values: {}, model: 'm' })).toThrow('cannot change type')
    expect(() => invoke('saveProvider', { providerId: 'openai', values: { nope: 'x' }, model: 'm' })).toThrow('Unknown provider field')
    expect(() => invoke('saveProvider', { providerId: 'openai', values: {}, model: 'm' })).toThrow('Enter API key')
    expect(() => invoke('saveProvider', { providerId: 'aws-transcribe', values: {}, model: 'm' })).toThrow('Coming later')
  })

  it('refuses keys without secure OS encryption', () => {
    mocks.encryptionAvailable = false
    expect(() => invoke('saveProvider', { providerId: 'openai', values: { apiKey: 'private-api-key' }, model: 'whisper-1' })).toThrow('secure key storage')
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })

  it('lists every adapter without secrets and marks the unavailable ones', () => {
    const list = invoke('providers') as { id: string; unavailable?: string }[]
    const ids = list.map((p) => p.id)
    for (const id of [
      'openai', 'groq', 'deepgram', 'assemblyai', 'elevenlabs', 'google', 'azure', 'speechmatics', 'revai', 'gladia', 'mistral',
      'fireworks', 'together', 'openrouter', 'openai-compatible', 'whisper-cpp', 'speaches', 'localai', 'local-openai-compatible'
    ]) expect(ids).toContain(id)
    expect(list.find((p) => p.id === 'aws-transcribe')!.unavailable).toMatch(/later/)
  })

  it('migrates the old single-API config into a configured provider with its key', () => {
    invoke('getConfig')
    invoke('saveConfig', { handsFree: false })
    mocks.files.set(configFile(), JSON.stringify({
      options: { mode: 'api', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', handsFree: true },
      encryptedKey: Buffer.from('encrypted:yek-ipa-etavirp').toString('base64')
    }))
    const config = invoke('getConfig')
    expect(config).toMatchObject({ source: 'provider:migrated', handsFree: true })
    expect(config.providers[0]).toMatchObject({ id: 'migrated', providerId: 'openai', hasSecret: { apiKey: true }, model: 'whisper-1' })
  })

  it('migrates the old local-server config without making it active', () => {
    invoke('saveConfig', { handsFree: false })
    mocks.files.set(configFile(), JSON.stringify({ options: { mode: 'local', baseUrl: 'http://127.0.0.1:9000/v1', model: 'whisper-1' }, encryptedKey: '' }))
    const config = invoke('getConfig')
    expect(config.source).toBe('local:whisper-base')
    expect(config.providers[0]).toMatchObject({ providerId: 'local-openai-compatible', values: { baseUrl: 'http://127.0.0.1:9000/v1' } })
  })

  it('does not transcribe in main while a local model is active', async () => {
    await expect(later(() => invoke('transcribe', audio))).rejects.toThrow('local model')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for word times and adds no authorization for a server on this computer', async () => {
    localServer()
    invoke('saveConfig', { language: 'en' })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      text: '  append this command  ', words: [{ word: 'append', start: 0, end: 0.5 }, { word: 'this', start: 0.5, end: 0.7 }]
    })))
    expect(await invoke('transcribe', audio)).toEqual({
      text: 'append this command', words: [{ text: 'append', start: 0, end: 0.5 }, { text: 'this', start: 0.5, end: 0.7 }],
      wordTimesApproximate: false, language: undefined, model: 'whisper-1'
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {} })
    const form = init!.body as FormData
    expect(form.get('file')).toMatchObject({ name: 'audio.webm', type: 'audio/webm', size: 4 })
    expect(form.get('language')).toBe('en')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
  })

  it('sends no audio to a "local" server that is on another machine', async () => {
    localServer('http://192.168.1.4:8080/v1')
    await expect(later(() => invoke('transcribe', audio))).rejects.toThrow('this computer')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('decrypts the key only in main, for the authorization header', async () => {
    openaiConfig()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'command' })))
    expect(await invoke('transcribe', audio)).toMatchObject({ text: 'command', words: [], wordTimesApproximate: true })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer private-api-key' })
    expect(mocks.decrypt).toHaveBeenCalled()
  })

  it('does not retry or fall back when the server fails, and never shows the key', async () => {
    openaiConfig()
    fetchMock.mockRejectedValue(new Error('private-api-key leaked detail'))
    const error = (await later(() => invoke('transcribe', audio)).catch((e: Error) => e)) as Error
    expect(error.message).toMatch(/Could not reach OpenAI/)
    expect(error.message).not.toContain('private-api-key')
    expect(fetchMock).toHaveBeenCalledOnce()
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(new Response('{"text":""}'))
    await expect(later(() => invoke('transcribe', audio))).rejects.toThrow('no transcript')
  })

  it.each(['cancel', 'timeout'] as const)('aborts on %s and disallows overlapping uploads', async (reason) => {
    openaiConfig()
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const pending = invoke('transcribe', audio)
    const rejected = expect(pending).rejects.toThrow('cancelled or timed out')
    await expect(later(() => invoke('transcribe', audio))).rejects.toThrow('Finish or cancel')
    if (reason === 'cancel') invoke('cancel')
    else await vi.advanceTimersByTimeAsync(DICTATION_TIMEOUT_MS)
    await rejected
  })

  it('falls back to the default local model when the active provider is removed', () => {
    const id = openaiConfig()
    expect(invoke('deleteProvider', id)).toMatchObject({ source: DEFAULT_DICTATION_OPTIONS.source, providers: [] })
  })

  it('downloads only catalog models and sends progress to the window', async () => {
    mocks.download.mockImplementation(async (_id: string, _dtype: string, progress: (p: unknown) => void) => {
      progress({ id: 'whisper-base', dtype: 'q8', state: 'downloading', received: 1, total: 2 })
    })
    await invoke('downloadModel', 'whisper-base', 'q8')
    expect(mocks.download).toHaveBeenCalledWith('whisper-base', 'q8', expect.any(Function))
    expect(sender.send).toHaveBeenCalledWith(DICTATION_PROGRESS_EVENT, { id: 'whisper-base', dtype: 'q8', state: 'downloading', received: 1, total: 2 })
    await expect(later(() => invoke('downloadModel', '../../etc', 'q8'))).rejects.toThrow('Unknown')
    await expect(later(() => invoke('downloadModel', 'whisper-base', 'q9'))).rejects.toThrow('Unknown model size')
    await expect(later(() => invoke('deleteModel', 'whisper-huge'))).rejects.toThrow('Unknown')
    expect(mocks.remove).not.toHaveBeenCalled()
    invoke('cancelDownload', 'whisper-base', 'q8')
    expect(mocks.cancelDownload).toHaveBeenCalledWith('whisper-base', 'q8')
  })

  it('removes only its own handlers on disposal', () => {
    mocks.handlers.set('unrelated', () => null)
    dispose()
    expect([...mocks.handlers.keys()]).toEqual(['unrelated'])
  })
})
