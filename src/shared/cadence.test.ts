import { describe, expect, it } from 'vitest'
import { addSample, analyzeWords, checkDraft, cleanProfile, emptyProfile, profileText, summarize, takeFeedback } from './cadence'
import type { SpokenWord } from './speech'

// words at a steady pace, with optional gaps before some of them
function speak(text: string, wpm = 150, gaps: Record<number, number> = {}, start = 0): SpokenWord[] {
  const per = 60 / wpm
  let t = start
  return text.split(/\s+/).map((w, i) => {
    t += gaps[i] ?? 0
    const word = { text: w, start: t, end: t + per * 0.8 }
    t += per
    return word
  })
}

const TALK =
  "So I tried this for a week. Um, it didn't go how I thought. You know what happened? I'm gonna show you. Honestly it's kind of wild. So I tried it again. And you won't believe it."

describe('cadence', () => {
  it('measures pace, sentences, fillers, contractions and second person', () => {
    const s = analyzeWords(speak(TALK, 150, { 10: 1.2 }))
    expect(s.wpm).toBeGreaterThan(130)
    expect(s.wpm).toBeLessThan(160)
    expect(s.sentenceLengths[0]).toBe(7)
    expect(s.pauses.some((p) => p >= 1.2)).toBe(true)
    expect(s.fillers).toBeGreaterThanOrEqual(3)
    expect(s.contractions).toBeGreaterThanOrEqual(4)
    expect(s.you).toBeGreaterThanOrEqual(3)
    expect(s.phrases['so i tried']).toBe(2)
  })

  it('takes long thinking pauses out of the pace', () => {
    const steady = analyzeWords(speak(TALK, 150))
    const gappy = analyzeWords(speak(TALK, 150, { 12: 20 }))
    expect(Math.abs(gappy.wpm - steady.wpm)).toBeLessThan(10)
  })

  it('builds a profile from samples and survives a round trip', () => {
    let p = emptyProfile()
    for (let i = 0; i < 5; i++) p = addSample(p, analyzeWords(speak(TALK, 140 + i * 5)), 1000)
    const s = summarize(p)
    expect(p.samples).toBe(5)
    expect(s.wpm.median).toBeGreaterThan(140)
    expect(s.favoritePhrases.map((f) => f.phrase)).toContain('so i tried')
    expect(cleanProfile(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(cleanProfile({ wpms: ['x', 3], vocab: { a: -1 } }).wpms).toEqual([3])
  })

  it('profile text stays empty until there is enough speech', () => {
    expect(profileText(addSample(emptyProfile(), analyzeWords(speak('hi there')), 1))).toBe('')
  })

  it('flags written-not-spoken lines but only length on spoken ones', () => {
    let p = emptyProfile()
    for (let i = 0; i < 12; i++) p = addSample(p, analyzeWords(speak(TALK)), 1)
    const long =
      'This is a sentence that goes on and on and on with many many words that no person would ever say in one breath on camera to anyone at all.'
    const check = checkDraft(
      [
        { id: 'a', text: 'Moreover, it is important to note that this matters.', spoken: false },
        { id: 'b', text: long, spoken: true },
        { id: 'c', text: 'It works (mostly); trust me.', spoken: false },
        { id: 'd', text: "So I tried it again and it didn't work.", spoken: false }
      ],
      p
    )
    const kinds = (id: string): string[] => check.flags.filter((f) => f.lineId === id).map((f) => f.kind)
    expect(kinds('a')).toEqual(expect.arrayContaining(['ai-word', 'written']))
    expect(kinds('b')).toEqual(['long-sentence'])
    expect(kinds('c')).toContain('punctuation')
    expect(kinds('d')).toEqual([])
    expect(check.profiled).toBe(true)
    expect(check.seconds).toBeGreaterThan(10)
  })

  it('gives take feedback with times for fillers, pauses and pace', () => {
    let p = emptyProfile()
    for (let i = 0; i < 4; i++) p = addSample(p, analyzeWords(speak(TALK, 150)), 1)
    const fast = speak(`${TALK} ${TALK}`, 230, { 30: 2.5 })
    const f = takeFeedback(fast, p)
    expect(f.usualWpm).toBeGreaterThan(140)
    expect(f.longPauses[0].seconds).toBeGreaterThanOrEqual(2.5)
    expect(f.fillers.length).toBeGreaterThanOrEqual(2)
    expect(f.notes.some((n) => /sped up/.test(n.text))).toBe(true)
    expect(f.notes.every((n, i) => i === 0 || n.at >= f.notes[i - 1].at)).toBe(true)
  })
})
