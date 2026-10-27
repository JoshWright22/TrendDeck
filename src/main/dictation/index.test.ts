import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_CHANNELS, DICTATION_TIMEOUT_MS } from '../../shared/dictation'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  encryptionAvailable: true,
  encrypt: vi.fn((key: string) => Buffer.from(`encrypted:${key.split('').reverse().join('')}`)),
  decrypt: vi.fn((data: Buffer) => data.toString().slice(10).split('').reverse().join(''))
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

import { setupDictation } from './index'

let dispose: () => void
let sender: EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean }
const fetchMock = vi.fn<typeof fetch>()
const audio = { bytes: new ArrayBuffer(4), mimeType: 'audio/webm;codecs=opus' }

function invoke(name: keyof typeof DICTATION_CHANNELS, input?: unknown): unknown {
  return mocks.handlers.get(DICTATION_CHANNELS[name])!({ sender, senderFrame: sender.mainFrame }, input)
}

function apiConfig(): void {
  invoke('saveConfig', { mode: 'api', baseUrl: 'https://transcribe.example/v1', model: 'whisper-1' })
  invoke('saveApiKey', 'private-api-key')
}

beforeEach(() => {
  mocks.files.clear()
  mocks.handlers.clear()
  mocks.encryptionAvailable = true
  mocks.encrypt.mockClear()
  mocks.decrypt.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false })
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
      await expect(Promise.resolve().then(() => handler({ sender: {}, senderFrame: sender.mainFrame }))).rejects.toThrow()
      await expect(Promise.resolve().then(() => handler({ sender, senderFrame: { url: sender.mainFrame.url } }))).rejects.toThrow()
    }
    sender.mainFrame.url = 'https://untrusted.example'
    expect(() => invoke('getConfig')).toThrow('Untrusted')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stores encrypted key material and only returns hasKey', () => {
    apiConfig()
    expect(mocks.encrypt).toHaveBeenCalledWith('private-api-key')
    expect([...mocks.files.values()].join('')).not.toContain('private-api-key')
    expect(invoke('getConfig')).toEqual({ mode: 'api', baseUrl: 'https://transcribe.example/v1', model: 'whisper-1', hasKey: true })
    expect(JSON.stringify(invoke('getConfig'))).not.toContain('encryptedKey')
    invoke('saveConfig', { mode: 'api', baseUrl: 'https://other.example/v1', model: 'whisper-1' })
    expect(invoke('getConfig')).toMatchObject({ hasKey: false })
  })

  it('refuses API keys without secure OS encryption', () => {
    invoke('saveConfig', { mode: 'api', baseUrl: 'https://transcribe.example/v1', model: 'whisper-1' })
    mocks.encryptionAvailable = false
    expect(() => invoke('saveApiKey', 'private-api-key')).toThrow('secure key storage')
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })

  it('uses real multipart fetch and never adds authorization in local mode', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '  append this command  ' })))
    expect(await invoke('transcribe', audio)).toBe('append this command')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {} })
    const form = init!.body as FormData
    expect(form.get('file')).toMatchObject({ name: 'dictation.webm', type: 'audio/webm', size: 4 })
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('json')
  })

  it('decrypts only in main for the API authorization header', async () => {
    apiConfig()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'command' })))
    await invoke('transcribe', audio)
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer private-api-key' })
    expect(mocks.decrypt).toHaveBeenCalledOnce()
  })

  it('does not retry or fall back when local transcription fails', async () => {
    fetchMock.mockRejectedValue(new Error('private internal server detail'))
    await expect(invoke('transcribe', audio)).rejects.toThrow('no fallback')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('127.0.0.1')
  })

  it('rejects empty or oversized responses without returning server details', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"text":""}'))
    await expect(invoke('transcribe', audio)).rejects.toThrow('no transcript')
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)))
    await expect(invoke('transcribe', audio)).rejects.toThrow('exceeds 1 MiB')
  })

  it.each(['cancel', 'timeout'] as const)('aborts on %s and disallows overlapping uploads', async (reason) => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const pending = invoke('transcribe', audio)
    const rejected = expect(pending).rejects.toThrow('cancelled or timed out')
    await expect(invoke('transcribe', audio)).rejects.toThrow('Finish or cancel')
    if (reason === 'cancel') invoke('cancel')
    else await vi.advanceTimersByTimeAsync(DICTATION_TIMEOUT_MS)
    await rejected
  })

  it('removes only its own handlers on disposal', () => {
    mocks.handlers.set('unrelated', () => null)
    dispose()
    expect([...mocks.handlers.keys()]).toEqual(['unrelated'])
  })
})
