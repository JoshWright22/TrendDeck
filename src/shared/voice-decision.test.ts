import { describe, expect, it } from 'vitest'
import { saidYesOrNo, shortAnswer } from './voice-decision'

describe('yes and no by voice', () => {
  it('reads a short answer to an approval', () => {
    expect(shortAnswer('Yes.')).toBe('allow')
    expect(shortAnswer('yeah go ahead')).toBe('allow')
    expect(shortAnswer('approve it')).toBe('allow')
    expect(shortAnswer('no')).toBe('deny')
    expect(shortAnswer("don't do that")).toBe('deny')
    expect(shortAnswer('yes wait no')).toBe('deny')
  })

  it('leaves anything longer or unclear to a click', () => {
    expect(shortAnswer('so what I want is the gameplay cut together with the audio')).toBeNull()
    expect(shortAnswer('hmm')).toBeNull()
    expect(shortAnswer('')).toBeNull()
  })

  it('tells when a message says to keep or drop', () => {
    expect(saidYesOrNo("I'm going to approve the voice and positioning guide")).toBe(true)
    expect(saidYesOrNo('keep both')).toBe(true)
    expect(saidYesOrNo('drop the voice one')).toBe(true)
    expect(saidYesOrNo('what does the audience part mean')).toBe(false)
  })
})
