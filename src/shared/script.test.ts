import { describe, expect, it } from 'vitest'
import { allLines, changeLine, cleanClaims, findQuote, parseMarkdown, readiness, toMarkdown, writeScript, type Dump } from './script'
import type { SpokenWord } from './speech'

const words = (text: string, start = 0): SpokenWord[] => text.split(' ').map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.3 }))
const dump = (id: string, text: string): Dump => ({ id, at: 0, text, words: words(text), duration: 10 })
const DUMPS = [dump('d1', "So, um, I tried cold showers for a week. Honestly? It didn't go how I thought it would. The first day was brutal.")]

describe('script origins', () => {
  it('finds the creator lines verbatim, ignoring case, punctuation and fillers', () => {
    const q = findQuote('I tried cold showers for a week.', DUMPS)
    expect(q).toMatchObject({ dump: 'd1', edits: 0 })
    expect(q!.at).toBeCloseTo(0.8)
    expect(findQuote("it didn't go how i thought it would", DUMPS)?.edits).toBe(0)
    expect(findQuote('So I tried cold showers for a week', DUMPS)?.edits).toBe(0)
  })

  it('allows one word in ten to differ and no more', () => {
    expect(findQuote("Honestly it didn't go how I thought it would go", DUMPS)).not.toBeNull()
    expect(findQuote('I tried ice baths for a whole month', DUMPS)).toBeNull()
  })

  it('keeps spoken marks only for real quotes and marks the rest as suggestions', () => {
    const { script, downgraded } = writeScript(
      'Cold showers',
      [
        {
          title: 'Hook',
          lines: [
            { text: 'I tried cold showers for a week.', origin: 'spoken' },
            { text: "Here's what happened.", origin: 'suggestion' }
          ]
        },
        { title: 'Day one', lines: [{ text: 'The first day was absolutely terrible.', origin: 'spoken' }] }
      ],
      DUMPS,
      null
    )
    const lines = allLines(script)
    expect(lines.map((l) => l.origin)).toEqual(['spoken', 'agent', 'agent'])
    expect(lines[0].dump).toBe('d1')
    expect(downgraded).toEqual(['The first day was absolutely terrible.'])
  })

  it('keeps ids and the creator lines across rewrites', () => {
    const first = writeScript(
      'T',
      [
        {
          title: 'A',
          lines: [
            { text: 'I tried cold showers for a week.', origin: 'spoken' },
            { text: 'Glue.', origin: 'suggestion' }
          ]
        }
      ],
      DUMPS,
      null
    ).script
    const typed = changeLine(first, { type: 'type', lineId: allLines(first)[1].id, text: 'My own glue.' }).script
    const second = writeScript(
      'T',
      [
        {
          title: 'A',
          lines: [
            { text: 'My own glue.', origin: 'suggestion' },
            { text: 'I tried cold showers for a week.', origin: 'suggestion' }
          ]
        }
      ],
      DUMPS,
      typed
    ).script
    const [a, b] = allLines(second)
    expect(a).toMatchObject({ id: allLines(first)[1].id, origin: 'typed' })
    expect(b).toMatchObject({ id: allLines(first)[0].id, origin: 'spoken' })
  })

  it('round trips through markdown and reads hand edits', () => {
    const { script } = writeScript(
      'Cold showers',
      [
        {
          title: 'Hook',
          lines: [
            { text: 'I tried cold showers for a week.', origin: 'spoken' },
            { text: 'Next.', origin: 'suggestion' }
          ]
        }
      ],
      DUMPS,
      null
    )
    const md = toMarkdown(script)
    expect(md).toContain('- [you] I tried cold showers for a week.')
    expect(md).toContain('- [suggestion] Next.')
    expect(parseMarkdown(md)).toEqual(script)
    const edited = parseMarkdown(`${md}\n- a line I added by hand\n`)
    expect(allLines(edited).at(-1)).toMatchObject({ text: 'a line I added by hand', origin: 'typed' })
  })

  it('re-speaking makes a line the creator and logs what it replaced', () => {
    const { script } = writeScript('T', [{ title: 'A', lines: [{ text: 'Agent line.', origin: 'suggestion' }] }], DUMPS, null)
    const id = allLines(script)[0].id
    const r = changeLine({ ...script, status: 'ready' }, { type: 'respeak', lineId: id, text: 'what I would say', dump: 'd2', at: 1.5 })
    expect(r.before?.text).toBe('Agent line.')
    expect(allLines(r.script)[0]).toMatchObject({ id, origin: 'spoken', dump: 'd2', at: 1.5, text: 'what I would say' })
    expect(r.script.status).toBe('draft')
    expect(allLines(changeLine(r.script, { type: 'remove', lineId: id }).script)).toHaveLength(0)
  })

  it('blocks recording on unsourced stats and quotes', () => {
    const { script } = writeScript(
      'T',
      [
        {
          title: 'A',
          lines: [
            { text: '90% of people quit.', origin: 'suggestion' },
            { text: 'Water is wet.', origin: 'suggestion' }
          ]
        }
      ],
      DUMPS,
      null
    )
    const [a, b] = allLines(script)
    const ids = new Set([a.id, b.id])
    const claims = cleanClaims(
      [
        { id: 'c1', lineId: a.id, kind: 'stat', text: '90% quit', status: 'unchecked' },
        { id: 'c2', lineId: b.id, kind: 'fact', text: 'wet', status: 'unverifiable' },
        { id: 'c3', lineId: 'gone', kind: 'fact', text: 'x' }
      ],
      ids
    )
    expect(claims).toHaveLength(2)
    expect(readiness(script, claims)).toMatchObject({ ready: false })
    claims[0] = { ...claims[0], status: 'sourced', sourceUrl: 'https://example.com' }
    const r = readiness(script, claims)
    expect(r.ready).toBe(true)
    expect(r.warnings.map((c) => c.id)).toEqual(['c2'])
  })
})
