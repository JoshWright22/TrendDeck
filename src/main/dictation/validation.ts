import { DICTATION_MAX_BYTES, type DictationAudio, type DictationMode, type DictationOptions } from '../../shared/dictation'

export function transcriptionEndpoint(baseUrl: unknown, mode: DictationMode): string {
  if (mode !== 'local' && mode !== 'api') throw new Error('Invalid dictation mode.')
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || baseUrl !== baseUrl.trim()) {
    throw new Error('Enter a valid transcription base URL.')
  }
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash || /[\\\s]/.test(baseUrl)) {
    throw new Error('Endpoint must not contain credentials, query parameters, fragments or whitespace.')
  }
  if (mode === 'local') {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Local endpoint must use HTTP or HTTPS.')
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    if (!/^127\.\d+\.\d+\.\d+$/.test(url.hostname) && url.hostname !== '[::1]') {
      throw new Error('Local dictation requires a loopback endpoint (localhost, 127.x.x.x or [::1]).')
    }
  } else if (url.protocol !== 'https:') {
    throw new Error('API dictation requires HTTPS.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`
  return url.toString()
}

export function validateDictationOptions(input: unknown): DictationOptions {
  if (!input || typeof input !== 'object') throw new Error('Invalid dictation configuration.')
  const options = input as Record<string, unknown>
  if (Object.keys(options).some((key) => !['mode', 'baseUrl', 'model'].includes(key))) throw new Error('Unknown dictation option.')
  if (options.mode !== 'local' && options.mode !== 'api') throw new Error('Invalid dictation mode.')
  transcriptionEndpoint(options.baseUrl, options.mode)
  if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 200 || /[\x00-\x1f\x7f]/.test(options.model)) {
    throw new Error('Enter a model name (maximum 200 characters).')
  }
  return { mode: options.mode, baseUrl: options.baseUrl as string, model: options.model.trim() }
}

export function validateApiKey(key: unknown): string {
  if (typeof key !== 'string' || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) {
    throw new Error('Invalid API key (maximum 4096 characters, no whitespace).')
  }
  return key
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
