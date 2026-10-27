import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTATION_OPTIONS, DICTATION_MAX_BYTES } from '../../shared/dictation'
import { transcriptionEndpoint, validateApiKey, validateDictationAudio, validateDictationOptions } from './validation'

describe('dictation endpoints', () => {
  it.each([
    ['http://localhost:8080/v1/', 'http://127.0.0.1:8080/v1/audio/transcriptions'],
    ['http://127.0.0.2:8080', 'http://127.0.0.2:8080/audio/transcriptions'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1/audio/transcriptions']
  ])('allows loopback %s', (baseUrl, endpoint) => {
    expect(transcriptionEndpoint(baseUrl, 'local')).toBe(endpoint)
  })

  it.each([
    'https://api.example.com/v1', 'http://192.168.1.1/v1', 'http://0.0.0.0/v1',
    'http://localhost.example/v1', 'http://127.0.0.1.example/v1', 'http://[::ffff:127.0.0.1]/v1',
    'file:///tmp', 'ftp://127.0.0.1/v1', 'http://user:secret@127.0.0.1/v1',
    'http://127.0.0.1/v1?token=secret', 'http://127.0.0.1/v1#fragment',
    ' http://127.0.0.1/v1', 'http://127.0.0.1\\@remote.example/v1', 'not-a-url'
  ])('rejects unsafe local endpoint %s', (baseUrl) => {
    expect(() => transcriptionEndpoint(baseUrl, 'local')).toThrow()
  })

  it('requires HTTPS for API mode and never embeds credentials', () => {
    expect(transcriptionEndpoint('https://api.example.com/v1/', 'api')).toBe('https://api.example.com/v1/audio/transcriptions')
    expect(() => transcriptionEndpoint('http://api.example.com/v1', 'api')).toThrow()
    expect(() => transcriptionEndpoint('https://key@api.example.com/v1', 'api')).toThrow()
    expect(() => transcriptionEndpoint('https://api.example.com/v1?key=secret', 'api')).toThrow()
  })
})

describe('dictation configuration', () => {
  it('validates and copies options without exposing a key', () => {
    const options = validateDictationOptions({ ...DEFAULT_DICTATION_OPTIONS, model: ' whisper-1 ' })
    expect(options).toEqual(DEFAULT_DICTATION_OPTIONS)
    expect(options).not.toHaveProperty('apiKey')
  })

  it.each([
    null, [], {}, { ...DEFAULT_DICTATION_OPTIONS, mode: 'fallback' },
    { ...DEFAULT_DICTATION_OPTIONS, model: '' }, { ...DEFAULT_DICTATION_OPTIONS, model: 'a'.repeat(201) },
    { ...DEFAULT_DICTATION_OPTIONS, model: 'whisper\n' }, { ...DEFAULT_DICTATION_OPTIONS, apiKey: 'secret' },
    { ...DEFAULT_DICTATION_OPTIONS, baseUrl: 'https://remote.example/v1' }
  ])('rejects malformed configuration %j', (input) => {
    expect(() => validateDictationOptions(input)).toThrow()
  })

  it('allows key removal but rejects header injection and oversized keys', () => {
    expect(validateApiKey('')).toBe('')
    expect(validateApiKey('sk-private')).toBe('sk-private')
    for (const key of [null, 'bad\r\nheader', 'space key', 'a'.repeat(4097)]) expect(() => validateApiKey(key)).toThrow()
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
