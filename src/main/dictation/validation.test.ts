import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTATION_OPTIONS, DICTATION_MAX_BYTES } from '../../shared/dictation'
import {
  isLoopbackEndpoint, migrateDictationOptions, parseTranscript, transcriptionEndpoint, validateApiKey,
  validateDictationAudio, validateDictationOptions, validateHoldKey
} from './validation'

describe('dictation endpoints', () => {
  it.each([
    ['http://localhost:8080/v1/', 'http://127.0.0.1:8080/v1/audio/transcriptions'],
    ['http://127.0.0.2:8080', 'http://127.0.0.2:8080/audio/transcriptions'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1/audio/transcriptions'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1/audio/transcriptions']
  ])('allows %s', (baseUrl, endpoint) => {
    expect(transcriptionEndpoint(baseUrl)).toBe(endpoint)
  })

  it.each([
    'http://api.example.com/v1', 'http://192.168.1.1/v1', 'http://0.0.0.0/v1',
    'http://localhost.example/v1', 'http://127.0.0.1.example/v1', 'http://[::ffff:127.0.0.1]/v1',
    'file:///tmp', 'ftp://127.0.0.1/v1', 'http://user:secret@127.0.0.1/v1',
    'http://127.0.0.1/v1?token=secret', 'http://127.0.0.1/v1#fragment',
    ' http://127.0.0.1/v1', 'http://127.0.0.1\\@remote.example/v1', 'not-a-url', '',
    'https://key@api.example.com/v1', 'https://api.example.com/v1?key=secret'
  ])('rejects unsafe endpoint %s', (baseUrl) => {
    expect(() => transcriptionEndpoint(baseUrl)).toThrow()
  })

  it('knows which endpoints may run without a key', () => {
    expect(isLoopbackEndpoint('http://localhost:8080/v1')).toBe(true)
    expect(isLoopbackEndpoint('https://api.example.com/v1')).toBe(false)
    expect(isLoopbackEndpoint('nonsense')).toBe(false)
  })
})

describe('dictation configuration', () => {
  it('validates full options', () => {
    expect(validateDictationOptions({ ...DEFAULT_DICTATION_OPTIONS })).toEqual(DEFAULT_DICTATION_OPTIONS)
    expect(validateDictationOptions({ source: 'provider:abc-1' }).source).toBe('provider:abc-1')
    expect(validateDictationOptions({ source: 'local:custom-whisper-large-v3' }).source).toBe('local:custom-whisper-large-v3')
  })

  it('applies a partial update on top of the saved options', () => {
    const saved = { ...DEFAULT_DICTATION_OPTIONS, language: 'de' }
    expect(validateDictationOptions({ handsFree: true }, saved)).toEqual({ ...saved, handsFree: true })
    expect(validateDictationOptions({ source: 'local:whisper-tiny', localPrefs: { 'whisper-tiny': { dtype: 'q4', device: 'wasm' } } }, saved))
      .toEqual({ ...saved, source: 'local:whisper-tiny', localPrefs: { 'whisper-tiny': { dtype: 'q4', device: 'wasm' } } })
  })

  it.each([
    null, [], 'local', { mode: 'fallback' }, { model: '' }, { model: 'a'.repeat(201) }, { model: 'whisper\n' },
    { apiKey: 'x' }, { baseUrl: 'http://remote.example/v1' }, { localModel: 'whisper-huge' }, { localModel: 'toString' },
    { language: 'xx' }, { language: null }, { autoSend: 'yes' }, { handsFree: 1 }, { autoSendPauseMs: 100 },
    { autoSendPauseMs: 60_000 }, { autoSendPauseMs: 1500.5 }, { holdKey: 'A' }, { holdKey: 'Ctrl+Enter' }
  ])('rejects malformed configuration %j', (input) => {
    expect(() => validateDictationOptions(input)).toThrow()
  })

  it('accepts hold-to-talk shortcuts with a modifier or an F key', () => {
    for (const key of ['Ctrl+Space', 'Ctrl+Shift+D', 'Alt+Backquote', 'F8', 'Meta+F12']) expect(validateHoldKey(key)).toBe(key)
    for (const key of ['Space', 'D', 'Ctrl+Ctrl+D', 'Hyper+D', 'Ctrl+', 'Ctrl+Space+X', 'Ctrl+space']) expect(() => validateHoldKey(key)).toThrow()
  })

  it('hands back the old single API config so it can become a provider', () => {
    const old = { mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1', handsFree: true }
    expect(migrateDictationOptions(old)).toEqual({ options: { ...DEFAULT_DICTATION_OPTIONS, handsFree: true }, legacy: { mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1' } })
    const api = { mode: 'api', baseUrl: 'https://transcribe.example/v1', model: 'whisper-large' }
    expect(migrateDictationOptions(api).legacy).toEqual(api)
    // the first local-model version kept the model in localModel
    expect(migrateDictationOptions({ localModel: 'whisper-small' }).options.source).toBe('local:whisper-small')
  })

  it('replaces unreadable stored fields with defaults instead of failing', () => {
    const stored = { mode: 'api', baseUrl: 'gopher://x', source: 'local:gone', language: 'fr', extra: true }
    expect(migrateDictationOptions(stored)).toEqual({ options: { ...DEFAULT_DICTATION_OPTIONS, language: 'fr' }, legacy: null })
    expect(() => migrateDictationOptions(null)).toThrow()
  })

  it('allows key removal but rejects header injection and oversized keys', () => {
    expect(validateApiKey('')).toBe('')
    expect(validateApiKey('placeholder-key')).toBe('placeholder-key')
    for (const key of [null, 'bad\r\nheader', 'space key', 'a'.repeat(4097)]) expect(() => validateApiKey(key)).toThrow()
  })
})

describe('dictation transcripts', () => {
  it('reads verbose_json words', () => {
    expect(parseTranscript({
      text: ' hello there ',
      words: [{ word: 'hello', start: 0, end: 0.4 }, { word: ' there', start: 0.4, end: 0.9 }, { word: 'bad', start: 2, end: 1 }]
    })).toEqual({ text: 'hello there', words: [{ text: 'hello', start: 0, end: 0.4 }, { text: 'there', start: 0.4, end: 0.9 }] })
  })

  it('falls back to text only', () => {
    expect(parseTranscript({ text: 'hello' })).toEqual({ text: 'hello', words: [] })
    expect(parseTranscript({ text: 'hello', words: 'nope' })).toEqual({ text: 'hello', words: [] })
    expect(() => parseTranscript({ text: ' ' })).toThrow('no transcript')
    expect(() => parseTranscript(null)).toThrow('no transcript')
  })
})

describe('dictation audio', () => {
  it('normalizes recorder MIME parameters', () => {
    expect(validateDictationAudio({ bytes: new ArrayBuffer(4), mimeType: 'audio/webm;codecs=opus' })).toMatchObject({ mimeType: 'audio/webm', extension: 'webm' })
  })

  it.each([
    null, {}, { bytes: new ArrayBuffer(0), mimeType: 'audio/webm' },
    { bytes: new Uint8Array(1), mimeType: 'audio/webm' },
    { bytes: new ArrayBuffer(1), mimeType: 'text/plain' },
    { bytes: new ArrayBuffer(1), mimeType: 'toString' },
    { bytes: new ArrayBuffer(DICTATION_MAX_BYTES + 1), mimeType: 'audio/webm' }
  ])('rejects invalid or oversized audio', (input) => {
    expect(() => validateDictationAudio(input)).toThrow()
  })
})
