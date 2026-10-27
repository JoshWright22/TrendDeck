import { app, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_DICTATION_OPTIONS, DICTATION_CHANNELS, DICTATION_TIMEOUT_MS,
  type DictationConfig, type DictationOptions
} from '../../shared/dictation'
import { transcriptionEndpoint, validateApiKey, validateDictationAudio, validateDictationOptions } from './validation'

interface StoredConfig {
  options: DictationOptions
  encryptedKey: string
}

export function setupDictation(window: BrowserWindow, trustedRendererUrl: string): () => void {
  const webContents = window.webContents
  const configPath = join(app.getPath('userData'), 'dictation', 'config.json')
  const trustedUrl = new URL(trustedRendererUrl)
  trustedUrl.hash = ''
  let active: AbortController | null = null
  let disposed = false

  function authorize(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame
    if (disposed || window.isDestroyed() || event.sender !== webContents || !frame || frame !== webContents.mainFrame) {
      throw new Error('Dictation is only available to the application window.')
    }
    const senderUrl = new URL(frame.url)
    senderUrl.hash = ''
    if (senderUrl.href !== trustedUrl.href) throw new Error('Untrusted dictation sender.')
  }

  function load(): StoredConfig {
    if (!existsSync(configPath)) return { options: { ...DEFAULT_DICTATION_OPTIONS }, encryptedKey: '' }
    try {
      const stored = JSON.parse(readFileSync(configPath, 'utf8')) as StoredConfig
      const options = validateDictationOptions(stored.options)
      if (typeof stored.encryptedKey !== 'string' || stored.encryptedKey.length > 32_768) throw new Error()
      return { options, encryptedKey: stored.encryptedKey }
    } catch {
      throw new Error('Dictation configuration could not be read. Restore or remove its config.json to reset it.')
    }
  }

  function publicConfig(stored: StoredConfig): DictationConfig {
    return { ...stored.options, hasKey: !!stored.encryptedKey }
  }

  function persist(stored: StoredConfig): DictationConfig {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(`${configPath}.tmp`, JSON.stringify(stored), { mode: 0o600 })
    renameSync(`${configPath}.tmp`, configPath)
    return publicConfig(stored)
  }

  function requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('OS-backed secure key storage is unavailable. API keys cannot be saved or used.')
    }
  }

  function idle(): void {
    if (active) throw new Error('Finish or cancel the current transcription first.')
  }

  ipcMain.handle(DICTATION_CHANNELS.getConfig, (event) => {
    authorize(event)
    return publicConfig(load())
  })
  ipcMain.handle(DICTATION_CHANNELS.saveConfig, (event, input: unknown) => {
    authorize(event)
    idle()
    const options = validateDictationOptions(input)
    const stored = load()
    const sameEndpoint = transcriptionEndpoint(stored.options.baseUrl, stored.options.mode) === transcriptionEndpoint(options.baseUrl, options.mode)
    return persist({ options, encryptedKey: sameEndpoint && stored.options.mode === options.mode ? stored.encryptedKey : '' })
  })
  ipcMain.handle(DICTATION_CHANNELS.saveApiKey, (event, input: unknown) => {
    authorize(event)
    idle()
    const key = validateApiKey(input)
    const stored = load()
    if (key) {
      if (stored.options.mode !== 'api') throw new Error('Choose API mode before saving a key.')
      requireEncryption()
    }
    return persist({ ...stored, encryptedKey: key ? safeStorage.encryptString(key).toString('base64') : '' })
  })
  ipcMain.handle(DICTATION_CHANNELS.cancel, (event) => {
    authorize(event)
    active?.abort()
  })
  ipcMain.handle(DICTATION_CHANNELS.transcribe, async (event, input: unknown) => {
    authorize(event)
    idle()
    const audio = validateDictationAudio(input)
    const stored = load()
    const endpoint = transcriptionEndpoint(stored.options.baseUrl, stored.options.mode)
    const headers: Record<string, string> = {}
    if (stored.options.mode === 'api') {
      if (!stored.encryptedKey) throw new Error('Save an API key before using API dictation.')
      requireEncryption()
      try {
        headers.Authorization = `Bearer ${validateApiKey(safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')))}`
      } catch {
        throw new Error('The saved API key could not be decrypted. Save it again.')
      }
    }
    const controller = new AbortController()
    active = controller
    const timeout = setTimeout(() => controller.abort(), DICTATION_TIMEOUT_MS)
    try {
      const form = new FormData()
      form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), `dictation.${audio.extension}`)
      form.append('model', stored.options.model)
      form.append('response_format', 'json')
      const response = await fetch(endpoint, { method: 'POST', body: form, headers, signal: controller.signal, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Transcription server returned HTTP ${response.status}.`)
      }
      if (!response.body) throw new Error('Transcription server returned no response.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new Error('Transcription response exceeds 1 MiB.')
        }
        chunks.push(chunk.value)
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown }
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('Transcription server returned no transcript.')
      return result.text.trim()
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Transcription cancelled or timed out.')
      if (error instanceof Error && /^(Transcription server returned|Transcription response exceeds)/.test(error.message)) throw error
      throw new Error('Transcription failed. Check the endpoint, model and server; no fallback was attempted.')
    } finally {
      clearTimeout(timeout)
      active = null
    }
  })

  const abort = (): void => { active?.abort() }
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => { if (mainFrame) abort() }
  webContents.on('did-start-navigation', navigation)
  webContents.on('render-process-gone', abort)
  window.once('closed', dispose)

  function dispose(): void {
    if (disposed) return
    disposed = true
    abort()
    for (const channel of Object.values(DICTATION_CHANNELS)) ipcMain.removeHandler(channel)
    if (!webContents.isDestroyed()) {
      webContents.removeListener('did-start-navigation', navigation)
      webContents.removeListener('render-process-gone', abort)
    }
    window.removeListener('closed', dispose)
  }
  return dispose
}
