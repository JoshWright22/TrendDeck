import { describe, expect, it } from 'vitest'
import { cleanError } from './plain-error'

describe('cleanError', () => {
  it('drops the remote method wrapper', () => {
    expect(cleanError(new Error("Error invoking remote method 'dictation:set-source': Error: Download Whisper Base first."))).toBe('Download Whisper Base first.')
    expect(cleanError(new Error("Error invoking remote method 'x': TypeError: bad"))).toBe('bad')
    expect(cleanError(new Error('Microphone access was blocked.'))).toBe('Microphone access was blocked.')
  })

  it('uses the fallback when there is nothing to show', () => {
    expect(cleanError(null, 'Transcription failed.')).toBe('Transcription failed.')
    expect(cleanError(new Error(''), 'Transcription failed.')).toBe('Transcription failed.')
    expect(cleanError('plain text')).toBe('plain text')
    expect(cleanError(42)).toBe('42')
  })
})
