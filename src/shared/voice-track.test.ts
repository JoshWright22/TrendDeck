import { describe, expect, it } from 'vitest'
import { planVoice, toSrt } from './voice-track'

const w = (text: string, start: number, end: number): { text: string; start: number; end: number } => ({ text, start, end })

describe('planVoice', () => {
  it('cuts long pauses, keeps a breath, and times captions to where the words land', () => {
    const plan = planVoice([{ id: 'd1', words: [w('Yo,', 1, 1.3), w("what's", 1.4, 1.6), w('up.', 1.7, 2), w('Today', 12, 12.4), w('we', 12.5, 12.6), w('talk.', 12.7, 13)] }], 10)
    expect(plan.segments).toHaveLength(2)
    expect(plan.segments[0]).toMatchObject({ dump: 'd1', at: 10 })
    expect(plan.segments[0].sourceIn).toBeCloseTo(0.88)
    expect(plan.segments[0].sourceOut).toBeCloseTo(2.12)
    // the 10 second pause is gone, a 0.15 s breath is left
    expect(plan.segments[1].at).toBeCloseTo(10 + 1.24 + 0.15)
    expect(plan.captions.map((c) => c.text)).toEqual(["Yo, what's up.", 'Today we talk.'])
    expect(plan.captions[1].start).toBeCloseTo(plan.segments[1].at + 0.12)
    expect(plan.end).toBeCloseTo(plan.segments[1].at + 1.24)
  })

  it('breaks a long line into captions that fit', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ').map((t, i) => w(t, i * 0.4, i * 0.4 + 0.3))
    const plan = planVoice([{ id: 'd', words }], 0, { maxChars: 20 })
    expect(plan.captions.length).toBeGreaterThan(2)
    for (const c of plan.captions) expect(c.text.length).toBeLessThanOrEqual(20)
  })

  it('writes srt', () => {
    expect(toSrt([{ start: 1.5, end: 62.25, text: 'Hi' }])).toBe('1\n00:00:01,500 --> 00:01:02,250\nHi\n')
  })
})
