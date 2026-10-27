import { describe, expect, it } from 'vitest'
import type { ScriptLine } from './script'
import type { SpokenWord } from './speech'
import { diffTake, paraphrases } from './take-diff'

const line = (id: string, text: string): ScriptLine => ({ id, text, origin: 'agent', dump: null, at: null })
const say = (text: string): SpokenWord[] => text.split(' ').map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.3 }))

const SCRIPT = [
  line('a', 'I tried cold showers for a week.'),
  line('b', 'The first day was brutal.'),
  line('c', 'By day four I actually liked them.'),
  line('d', 'Here is what I learned.')
]

describe('take vs script', () => {
  it('marks lines said, missed, flubbed and paraphrased with times', () => {
    const take = say('Um so I tried cold showers for a week. The first, the first day was brutal. By the fourth day honestly I kind of started to enjoy them a lot.')
    const d = diffTake(SCRIPT, take, 'scripts/script.md')
    const by = Object.fromEntries(d.lines.map((l) => [l.lineId, l]))
    expect(by.a.status).toBe('said')
    expect(by.a.from).toBeCloseTo(0.8)
    expect(by.b.status).toBe('flubbed')
    expect(by.c.status).toBe('paraphrased')
    expect(by.d.status).toBe('missed')
    expect(d.pickups.map((p) => p.lineId)).toEqual(['b', 'c', 'd'])
    expect(d.pickups.find((p) => p.lineId === 'd')?.at).toBeNull()
    expect(d.pickups.find((p) => p.lineId === 'b')?.at).not.toBeNull()
    expect(paraphrases(d).map((p) => p.lineId)).toEqual(['c'])
  })

  it('a clean read has no pickups', () => {
    const d = diffTake(SCRIPT, say(SCRIPT.map((l) => l.text).join(' ')))
    expect(d.lines.every((l) => l.status === 'said')).toBe(true)
    expect(d.pickups).toEqual([])
  })

  it('lines read out of order still match one of them', () => {
    const d = diffTake(SCRIPT.slice(0, 2), say('The first day was brutal. I tried cold showers for a week.'))
    expect(d.lines.filter((l) => l.status !== 'missed')).toHaveLength(1)
  })
})
