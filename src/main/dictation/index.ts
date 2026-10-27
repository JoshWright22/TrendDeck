import { app, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_DICTATION_OPTIONS, DICTATION_CHANNELS, DICTATION_PROGRESS_EVENT, DICTATION_TIMEOUT_MS, LOCAL_DTYPES, prefsFor, sourceParts,
  type ApiTranscript, type DictationConfig, type DictationOptions, type LocalDtype, type ProviderConfig, type SttModelInfo
} from '../../shared/dictation'
import { registerSecretSource } from '../gateway/secrets'
import {
  PROVIDER_CONFIG_ID, migrateDictationOptions, validateDictationAudio, validateDictationOptions, validateFieldValue, validateSource
} from './validation'
import {
  addCustomModel, cancelDownload, customModels, deleteModel, downloadModel, findModel, installedDtypes, isInstalled, modelsState,
  removeCustomModel
} from './models'
import type { SttProvider } from './providers'
import { allProviders, findProvider, legacyProvider, providerInfo } from './sources'

// a configured provider as stored: secret field values only as safeStorage ciphertext
interface StoredProvider {
  id: string
  providerId: string
  label: string
  values: Record<string, string>
  secrets: Record<string, string>
  model: string
}

interface StoredConfig {
  version: 2
  options: DictationOptions
  providers: StoredProvider[]
}

const configPath = (): string => join(app.getPath('userData'), 'dictation', 'config.json')

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('OS-backed secure key storage is unavailable. API keys cannot be saved or used.')
  }
}

function decrypt(cipher: string): string {
  requireEncryption()
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    throw new Error('A saved key could not be decrypted. Save it again in Settings, Dictation.')
  }
}

// every format this file has had: { options, encryptedKey } (one API), then version 2
export function loadStored(): StoredConfig {
  const path = configPath()
  if (!existsSync(path)) return { version: 2, options: { ...DEFAULT_DICTATION_OPTIONS }, providers: [] }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Dictation configuration could not be read. Restore or remove its config.json to reset it.')
  }
  if (raw?.version === 2) {
    const { options } = migrateDictationOptions(raw.options)
    const providers = Array.isArray(raw.providers) ? (raw.providers as StoredProvider[]).filter(validStoredProvider) : []
    return { version: 2, options, providers }
  }
  // the single-API versions
  let migrated: ReturnType<typeof migrateDictationOptions>
  try {
    migrated = migrateDictationOptions(raw?.options)
  } catch {
    throw new Error('Dictation configuration could not be read. Restore or remove its config.json to reset it.')
  }
  const encryptedKey = typeof raw.encryptedKey === 'string' && raw.encryptedKey.length <= 32_768 ? raw.encryptedKey : ''
  const providers: StoredProvider[] = []
  const { legacy } = migrated
  const options = migrated.options
  const keep = legacy && (legacy.mode === 'api' || encryptedKey || legacy.baseUrl !== 'http://127.0.0.1:8080/v1')
  if (legacy && keep) {
    const { provider, values, keyField } = legacyProvider(legacy)
    providers.push({
      id: 'migrated',
      providerId: provider.id,
      label: provider.label,
      values,
      secrets: keyField && encryptedKey ? { [keyField]: encryptedKey } : {},
      model: legacy.model
    })
    if (legacy.mode === 'api') options.source = 'provider:migrated'
  }
  const stored: StoredConfig = { version: 2, options, providers }
  persistStored(stored)
  return stored
}

function validStoredProvider(p: StoredProvider): boolean {
  return !!p && PROVIDER_CONFIG_ID.test(p.id) && typeof p.providerId === 'string' && typeof p.model === 'string' &&
    !!p.values && typeof p.values === 'object' && !!p.secrets && typeof p.secrets === 'object'
}

function persistStored(stored: StoredConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(stored), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

function providerConfig(p: StoredProvider): ProviderConfig {
  const provider = findProvider(p.providerId)
  let host = ''
  try {
    host = provider?.host({ ...p.values }) ?? ''
  } catch {
    host = ''
  }
  const hasSecret: Record<string, boolean> = {}
  for (const f of provider?.fields ?? []) if (f.secret) hasSecret[f.key] = !!p.secrets[f.key]
  return { id: p.id, providerId: p.providerId, label: p.label, values: { ...p.values }, hasSecret, model: p.model, host, kind: provider?.kind ?? 'api' }
}

export function publicConfig(stored: StoredConfig): DictationConfig {
  return { ...stored.options, providers: stored.providers.map(providerConfig), customModels: customModels() }
}

function fullValues(p: StoredProvider): Record<string, string> {
  const cfg = { ...p.values }
  for (const [k, cipher] of Object.entries(p.secrets)) cfg[k] = decrypt(cipher)
  return cfg
}

// every saved secret value, so tool results and the audit log never show one
export function dictationSecrets(): string[] {
  try {
    if (!safeStorage.isEncryptionAvailable()) return []
    return loadStored().providers.flatMap((p) => Object.values(p.secrets).flatMap((c) => {
      try {
        const v = safeStorage.decryptString(Buffer.from(c, 'base64'))
        return v.length >= 4 ? [v] : []
      } catch {
        return []
      }
    }))
  } catch {
    return []
  }
}

let secretsRegistered = false

export function setupDictation(window: BrowserWindow, trustedRendererUrl: string): () => void {
  const webContents = window.webContents
  const trustedUrl = new URL(trustedRendererUrl)
  trustedUrl.hash = ''
  let active: AbortController | null = null
  let disposed = false
  if (!secretsRegistered) {
    secretsRegistered = true
    registerSecretSource(dictationSecrets)
  }

  function authorize(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame
    if (disposed || window.isDestroyed() || event.sender !== webContents || !frame || frame !== webContents.mainFrame) {
      throw new Error('Dictation is only available to the application window.')
    }
    const senderUrl = new URL(frame.url)
    senderUrl.hash = ''
    if (senderUrl.href !== trustedUrl.href) throw new Error('Untrusted dictation sender.')
  }

  function idle(): void {
    if (active) throw new Error('Finish or cancel the current transcription first.')
  }

  function provider(id: unknown): { stored: StoredConfig; entry: StoredProvider; impl: SttProvider } {
    const stored = loadStored()
    const entry = stored.providers.find((p) => p.id === id)
    if (!entry) throw new Error('That provider is not configured.')
    const impl = findProvider(entry.providerId)
    if (!impl) throw new Error('That provider is no longer available.')
    if (impl.unavailable) throw new Error(impl.unavailable)
    return { stored, entry, impl }
  }

  function dtypeArg(input: unknown): LocalDtype {
    if (!LOCAL_DTYPES.includes(input as LocalDtype)) throw new Error('Unknown model size.')
    return input as LocalDtype
  }

  // a fetch for adapters: no redirects unless they ask, cancelled with the transcription
  const guardedFetch = (signal?: AbortSignal): typeof fetch => (input, init) =>
    fetch(input, { ...init, redirect: init?.redirect ?? 'error', signal: init?.signal ?? signal })

  ipcMain.handle(DICTATION_CHANNELS.getConfig, (event) => {
    authorize(event)
    return publicConfig(loadStored())
  })
  ipcMain.handle(DICTATION_CHANNELS.saveConfig, (event, input: unknown) => {
    authorize(event)
    const stored = loadStored()
    const patch = input as Record<string, unknown> | null
    // the source has its own checks, see setSource
    if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'source')) throw new Error('Pick the dictation source with setSource.')
    stored.options = validateDictationOptions(input, stored.options)
    persistStored(stored)
    return publicConfig(stored)
  })
  ipcMain.handle(DICTATION_CHANNELS.setSource, (event, input: unknown) => {
    authorize(event)
    const source = validateSource(input)
    const stored = loadStored()
    const parts = sourceParts(source)!
    if (parts.kind === 'local') {
      const info = findModel(parts.id)
      if (!info) throw new Error('Unknown model.')
      const prefs = prefsFor(info, stored.options.localPrefs)
      if (!isInstalled(info.id, prefs.dtype)) {
        // a different download of the same model works too
        const other = installedDtypes(info.id)[0]
        if (!other) throw new Error(`Download ${info.label} first.`)
        stored.options.localPrefs = { ...stored.options.localPrefs, [info.id]: { ...prefs, dtype: other } }
      }
    } else {
      const entry = stored.providers.find((p) => p.id === parts.id)
      if (!entry) throw new Error('That provider is not configured.')
      if (findProvider(entry.providerId)?.unavailable) throw new Error(findProvider(entry.providerId)!.unavailable)
    }
    stored.options.source = source
    persistStored(stored)
    return publicConfig(stored)
  })
  ipcMain.handle(DICTATION_CHANNELS.cancel, (event) => {
    authorize(event)
    active?.abort()
  })

  // ---------- local models ----------

  ipcMain.handle(DICTATION_CHANNELS.models, (event) => {
    authorize(event)
    return modelsState()
  })
  ipcMain.handle(DICTATION_CHANNELS.downloadModel, async (event, id: unknown, dtype: unknown) => {
    authorize(event)
    const info = findModel(id)
    if (!info) throw new Error('Unknown model.')
    await downloadModel(info.id, dtypeArg(dtype), (progress) => {
      if (!disposed && !webContents.isDestroyed()) webContents.send(DICTATION_PROGRESS_EVENT, progress)
    })
    return modelsState()
  })
  ipcMain.handle(DICTATION_CHANNELS.cancelDownload, (event, id: unknown, dtype: unknown) => {
    authorize(event)
    const info = findModel(id)
    if (info) cancelDownload(info.id, dtypeArg(dtype))
  })
  ipcMain.handle(DICTATION_CHANNELS.deleteModel, async (event, id: unknown, dtype: unknown) => {
    authorize(event)
    const info = findModel(id)
    if (!info) throw new Error('Unknown model.')
    await deleteModel(info.id, dtype === undefined ? undefined : dtypeArg(dtype))
    return modelsState()
  })
  ipcMain.handle(DICTATION_CHANNELS.addCustomModel, async (event, repo: unknown) => {
    authorize(event)
    await addCustomModel(repo)
    return publicConfig(loadStored())
  })
  ipcMain.handle(DICTATION_CHANNELS.removeCustomModel, async (event, id: unknown) => {
    authorize(event)
    await removeCustomModel(id)
    const stored = loadStored()
    if (stored.options.source === `local:${id}`) {
      stored.options.source = DEFAULT_DICTATION_OPTIONS.source
      persistStored(stored)
    }
    return publicConfig(stored)
  })

  // ---------- providers ----------

  ipcMain.handle(DICTATION_CHANNELS.providers, (event) => {
    authorize(event)
    return allProviders().map(providerInfo)
  })
  ipcMain.handle(DICTATION_CHANNELS.saveProvider, (event, input: unknown) => {
    authorize(event)
    idle()
    if (!input || typeof input !== 'object') throw new Error('Invalid provider settings.')
    const raw = input as { id?: unknown; providerId?: unknown; label?: unknown; values?: unknown; model?: unknown }
    const impl = findProvider(raw.providerId)
    if (!impl) throw new Error('Unknown provider.')
    if (impl.unavailable) throw new Error(impl.unavailable)
    const stored = loadStored()
    const existing = raw.id === undefined ? undefined : stored.providers.find((p) => p.id === raw.id)
    if (raw.id !== undefined && !existing) throw new Error('That provider is not configured.')
    if (existing && existing.providerId !== impl.id) throw new Error('A saved provider cannot change type. Add a new one.')
    const values = raw.values && typeof raw.values === 'object' ? (raw.values as Record<string, unknown>) : {}
    const known = new Set(impl.fields.map((f) => f.key))
    if (Object.keys(values).some((k) => !known.has(k))) throw new Error('Unknown provider field.')
    const plain: Record<string, string> = {}
    const secrets: Record<string, string> = { ...(existing?.secrets ?? {}) }
    let newSecret = false
    for (const f of impl.fields) {
      const v = values[f.key]
      if (f.secret) {
        if (v === null) delete secrets[f.key]
        else if (typeof v === 'string' && v !== '') {
          requireEncryption()
          secrets[f.key] = safeStorage.encryptString(validateFieldValue(v, true)).toString('base64')
          newSecret = true
        } else if (v !== undefined && v !== '') throw new Error(`Invalid ${f.label}.`)
      } else {
        plain[f.key] = v === undefined || v === null ? (existing?.values[f.key] ?? '') : validateFieldValue(v, false)
      }
    }
    // a key belongs to one server: a changed address never gets the old key
    if (existing && !newSecret) {
      const moved = impl.fields.some((f) => !f.secret && /url|endpoint|host|region|server/i.test(f.key) && (existing.values[f.key] ?? '') !== plain[f.key])
      if (moved) for (const k of Object.keys(secrets)) delete secrets[k]
    }
    for (const f of impl.fields) {
      if (f.required && (f.secret ? !secrets[f.key] : !plain[f.key])) throw new Error(`Enter ${f.label}.`)
    }
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : impl.defaultModel
    if (model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Enter a model name (maximum 200 characters).')
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : impl.label
    const entry: StoredProvider = { id: existing?.id ?? randomUUID().slice(0, 8), providerId: impl.id, label, values: plain, secrets, model }
    stored.providers = existing ? stored.providers.map((p) => (p.id === entry.id ? entry : p)) : [...stored.providers, entry]
    persistStored(stored)
    return publicConfig(stored)
  })
  ipcMain.handle(DICTATION_CHANNELS.deleteProvider, (event, id: unknown) => {
    authorize(event)
    idle()
    const stored = loadStored()
    if (!stored.providers.some((p) => p.id === id)) throw new Error('That provider is not configured.')
    stored.providers = stored.providers.filter((p) => p.id !== id)
    if (stored.options.source === `provider:${id}`) stored.options.source = DEFAULT_DICTATION_OPTIONS.source
    persistStored(stored)
    return publicConfig(stored)
  })
  ipcMain.handle(DICTATION_CHANNELS.testProvider, async (event, id: unknown) => {
    authorize(event)
    const { entry, impl } = provider(id)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const cfg = fullValues(entry)
      if (impl.test) {
        return await impl.test(cfg, guardedFetch(controller.signal), controller.signal)
      }
      if (impl.listModels) {
        await impl.listModels(cfg, guardedFetch(controller.signal), controller.signal)
        return { ok: true, message: 'Connected.' }
      }
      return { ok: true, message: 'Saved. This provider has no connection test, try a dictation.' }
    } catch (err) {
      return { ok: false, message: controller.signal.aborted ? 'No answer within 20 seconds.' : err instanceof Error ? err.message : 'The test failed.' }
    } finally {
      clearTimeout(timeout)
    }
  })
  ipcMain.handle(DICTATION_CHANNELS.providerModels, async (event, id: unknown): Promise<SttModelInfo[]> => {
    authorize(event)
    const { entry, impl } = provider(id)
    if (!impl.listModels) return impl.staticModels ?? []
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const live = await impl.listModels(fullValues(entry), guardedFetch(controller.signal), controller.signal)
      return live.length ? live : impl.staticModels ?? []
    } catch {
      return impl.staticModels ?? []
    } finally {
      clearTimeout(timeout)
    }
  })
  ipcMain.handle(DICTATION_CHANNELS.transcribe, async (event, input: unknown): Promise<ApiTranscript> => {
    authorize(event)
    idle()
    const audio = validateDictationAudio(input)
    const stored = loadStored()
    const parts = sourceParts(stored.options.source)
    if (parts?.kind !== 'provider') throw new Error('Dictation is set to a local model.')
    const { entry, impl } = provider(parts.id)
    const cfg = fullValues(entry)
    const controller = new AbortController()
    active = controller
    const timeout = setTimeout(() => controller.abort(), DICTATION_TIMEOUT_MS)
    try {
      const out = await impl.transcribe({
        // adapters take a plain ArrayBuffer, not a Node Buffer view
        audio: audio.bytes.slice(0), mimeType: audio.mimeType, model: entry.model,
        language: stored.options.language || undefined, signal: controller.signal
      }, cfg, guardedFetch(controller.signal))
      const text = typeof out?.text === 'string' ? out.text.trim() : ''
      if (!text) throw new Error('Transcription server returned no transcript.')
      const words = Array.isArray(out.words) ? out.words.filter((w) => w && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end)) : []
      return { text, words, wordTimesApproximate: !!out.wordTimesApproximate || !words.length, language: out.language, model: entry.model }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Transcription cancelled or timed out.')
      if (error instanceof Error && /^(Transcription server returned|Transcription response exceeds|Save an API key|A saved key)/.test(error.message)) throw error
      // adapters word their own errors without secrets; anything else stays generic
      const message = error instanceof Error && error.message.length < 300 && !Object.values(cfg).some((v) => v && v.length >= 4 && error.message.includes(v))
        ? error.message : ''
      throw new Error(message ? `Transcription failed: ${message}` : 'Transcription failed. Check the provider settings; no fallback was attempted.')
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
