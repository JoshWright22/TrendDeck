import {
  CUSTOM_ID, DEFAULT_DICTATION_OPTIONS, DICTATION_MAX_BYTES, DICTATION_PAUSE_MAX_MS, DICTATION_PAUSE_MIN_MS, LOCAL_DEVICES,
  LOCAL_DTYPES, LOCAL_MODELS, WHISPER_LANGUAGES, sourceParts, type DictationAudio, type DictationOptions, type LocalPrefs
} from '../../shared/dictation'
import type { SpokenWord } from '../../shared/speech'

// HTTPS anywhere, plain HTTP only to a server on this computer (localhost pinned to 127.0.0.1)
export function transcriptionEndpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048 || baseUrl !== baseUrl.trim()) {
    throw new Error('Enter a valid transcription base URL.')
  }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('Enter a valid transcription base URL.')
  }
  if (url.username || url.password || url.search || url.hash || /[\\\s]/.test(baseUrl)) {
    throw new Error('Endpoint must not contain credentials, query parameters, fragments or whitespace.')
  }
  if (url.protocol === 'http:') {
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    if (!isLoopback(url.hostname)) throw new Error('Use HTTPS, or HTTP only for a server on this computer.')
  } else if (url.protocol !== 'https:') {
    throw new Error('Use an HTTPS base URL.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`
  return url.toString()
}

function isLoopback(hostname: string): boolean {
  return /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '[::1]'
}

// a server on this computer can run without a key
export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    return new URL(transcriptionEndpoint(baseUrl)).protocol === 'http:'
  } catch {
    return false
  }
}

export function validateHoldKey(input: unknown): string {
  if (typeof input !== 'string' || input.length > 40) throw new Error('Invalid shortcut.')
  const parts = input.split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  if (mods.size !== parts.length || parts.some((m) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(m))) throw new Error('Invalid shortcut.')
  if (!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(key)) {
    throw new Error('Invalid shortcut.')
  }
  // a plain letter would fire while typing in the composer
  if (!mods.size && !/^F\d+$/.test(key)) throw new Error('Use a modifier like Ctrl with the key, or an F key.')
  return input
}

export function validLocalId(id: unknown): id is string {
  return typeof id === 'string' && (LOCAL_MODELS.some((m) => m.id === id) || CUSTOM_ID.test(id))
}

export const PROVIDER_CONFIG_ID = /^[A-Za-z0-9_-]{1,64}$/

type Checks = { [K in keyof DictationOptions]: (value: unknown) => DictationOptions[K] }

const checks: Checks = {
  source: (v) => {
    const parts = typeof v === 'string' && v.length <= 200 ? sourceParts(v) : null
    if (!parts || (parts.kind === 'local' && !validLocalId(parts.id)) || (parts.kind === 'provider' && !PROVIDER_CONFIG_ID.test(parts.id))) {
      throw new Error('Unknown dictation source.')
    }
    return v as string
  },
  localPrefs: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid model settings.')
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length > 200) throw new Error('Invalid model settings.')
    const out: Record<string, LocalPrefs> = {}
    for (const [id, raw] of entries) {
      const p = raw as Record<string, unknown> | null
      if (!validLocalId(id) || !p || typeof p !== 'object' || !LOCAL_DTYPES.includes(p.dtype as never) || !LOCAL_DEVICES.includes(p.device as never)) {
        throw new Error('Invalid model settings.')
      }
      out[id] = { dtype: p.dtype as LocalPrefs['dtype'], device: p.device as LocalPrefs['device'] }
    }
    return out
  },
  language: (v) => {
    if (typeof v !== 'string' || !WHISPER_LANGUAGES.some((l) => l.code === v)) throw new Error('Unknown language.')
    return v
  },
  autoSend: (v) => {
    if (typeof v !== 'boolean') throw new Error('Invalid auto send setting.')
    return v
  },
  autoSendPauseMs: (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < DICTATION_PAUSE_MIN_MS || v > DICTATION_PAUSE_MAX_MS) {
      throw new Error(`Pause must be between ${DICTATION_PAUSE_MIN_MS / 1000} and ${DICTATION_PAUSE_MAX_MS / 1000} seconds.`)
    }
    return v
  },
  holdKey: validateHoldKey,
  handsFree: (v) => {
    if (typeof v !== 'boolean') throw new Error('Invalid hands-free setting.')
    return v
  },
  mic: (v) => {
    if (typeof v !== 'string' || v.length > 200) throw new Error('Invalid microphone.')
    return v.trim()
  }
}

const KEYS = Object.keys(checks) as (keyof DictationOptions)[]

// a save: any subset of the options on top of what's saved. unknown keys are refused
export function validateDictationOptions(input: unknown, base: DictationOptions = DEFAULT_DICTATION_OPTIONS): DictationOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid dictation configuration.')
  const patch = input as Record<string, unknown>
  if (Object.keys(patch).some((key) => !(KEYS as string[]).includes(key))) throw new Error('Unknown dictation option.')
  const out = { ...base } as Record<keyof DictationOptions, unknown>
  for (const key of KEYS) if (Object.hasOwn(patch, key)) out[key] = checks[key](patch[key])
  return out as unknown as DictationOptions
}

export function validateSource(input: unknown): string {
  return checks.source(input)
}

// the API settings of the versions before providers: { mode, baseUrl, model }
export interface LegacyApi {
  mode: 'local' | 'api'
  baseUrl: string
  model: string
}

// what's on disk, from any older version: missing or unreadable fields fall back to defaults.
// the old single API config comes back separately so it can become a configured provider
export function migrateDictationOptions(input: unknown): { options: DictationOptions; legacy: LegacyApi | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid dictation configuration.')
  const stored = input as Record<string, unknown>
  const out = { ...DEFAULT_DICTATION_OPTIONS } as Record<keyof DictationOptions, unknown>
  for (const key of KEYS) {
    if (!Object.hasOwn(stored, key)) continue
    try {
      out[key] = checks[key](stored[key])
    } catch {
      // keep the default
    }
  }
  // the first local-model version kept the model in localModel
  if (!Object.hasOwn(stored, 'source') && validLocalId(stored.localModel)) out.source = `local:${stored.localModel}`
  let legacy: LegacyApi | null = null
  if (typeof stored.baseUrl === 'string' && (stored.mode === 'local' || stored.mode === 'api')) {
    try {
      transcriptionEndpoint(stored.baseUrl)
      const model = typeof stored.model === 'string' && stored.model.trim() && stored.model.length <= 200 ? stored.model.trim() : 'whisper-1'
      legacy = { mode: stored.mode, baseUrl: stored.baseUrl, model }
    } catch {
      legacy = null
    }
  }
  return { options: out as unknown as DictationOptions, legacy }
}

export function validateApiKey(key: unknown): string {
  if (typeof key !== 'string' || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) {
    throw new Error('Invalid API key (maximum 4096 characters, no whitespace).')
  }
  return key
}

// a provider field as typed in Settings: short, one line
export function validateFieldValue(value: unknown, secret: boolean): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid value.')
  if (secret && /\s/.test(value)) throw new Error('Keys cannot contain spaces.')
  return secret ? value : value.trim()
}

const extensions: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac'
}

export function validateDictationAudio(input: unknown): DictationAudio & { extension: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid audio upload.')
  const audio = input as Record<string, unknown>
  if (!(audio.bytes instanceof ArrayBuffer) || !audio.bytes.byteLength || audio.bytes.byteLength > DICTATION_MAX_BYTES) {
    throw new Error('Audio must be between 1 byte and 25 MiB.')
  }
  if (typeof audio.mimeType !== 'string' || audio.mimeType.length > 100) throw new Error('Invalid audio MIME type.')
  const mimeType = audio.mimeType.split(';')[0].trim().toLowerCase()
  if (!Object.hasOwn(extensions, mimeType)) throw new Error('Unsupported audio MIME type.')
  return { bytes: audio.bytes, mimeType, extension: extensions[mimeType] }
}

// verbose_json gives { text, words: [{ word, start, end }] }, plain json only { text }
export function parseTranscript(body: unknown): { text: string; words: SpokenWord[] } {
  const result = body as { text?: unknown; words?: unknown } | null
  if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('Transcription server returned no transcript.')
  const words: SpokenWord[] = []
  if (Array.isArray(result.words)) {
    for (const w of result.words as Record<string, unknown>[]) {
      const text = typeof w?.word === 'string' ? w.word.trim() : typeof w?.text === 'string' ? w.text.trim() : ''
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue
      words.push({ text, start, end })
    }
  }
  return { text: result.text.trim(), words }
}
