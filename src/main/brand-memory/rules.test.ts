import { describe, expect, it } from 'vitest'
import { MAX_RULES_PER_SESSION } from '@shared/brand-memory'
import { appendLearning, appendRule, cleanProposal, frictionText, newEvent, parseFriction, ruleEntry, rulesLeft, takeProposals, template, wrapUpPrompt } from './rules'

describe('rule cards', () => {
  it('caps proposals per session', () => {
    expect(MAX_RULES_PER_SESSION).toBe(3)
    expect(rulesLeft(0)).toBe(3)
    expect(rulesLeft(5)).toBe(0)
    expect(takeProposals(1, ['a', 'b', 'c'])).toEqual({ accepted: ['a', 'b'], refused: 1 })
    expect(takeProposals(3, ['a'])).toEqual({ accepted: [], refused: 1 })
  })

  it('needs text and evidence from the log', () => {
    const known = new Set(['e1'])
    expect(cleanProposal({ text: '' }, known)).toMatch(/needs text/)
    expect(cleanProposal({ text: 'x'.repeat(400), evidence: ['e1'] }, known)).toMatch(/under/)
    expect(cleanProposal({ text: 'Cut moreover', evidence: ['nope'] }, known)).toMatch(/evidence/)
    const ok = cleanProposal({ text: "  Cut   'Moreover' ", kind: 'weird', evidence: ['e1', 'nope'], examples: ['a', ''] }, known)
    expect(ok).toMatchObject({ text: "Cut 'Moreover'", kind: 'voice', evidence: ['e1'], examples: ['a'] })
  })

  it('writes rules with provenance into the right place', () => {
    const entry = ruleEntry('Open with a story', 'structure', { at: Date.UTC(2026, 9, 26), cardId: 'c1', evidence: ['e1', 'e2'], examples: ['"stat" to "story"'], edited: true })
    expect(entry).toContain('- Open with a story')
    expect(entry).toContain('kept 2026-10-26, structure rule, edited by you, card c1')
    expect(entry).toContain('from 2 changes: e1, e2')
    const rules = appendRule(template('rules.md', 'Acme'), entry, 'rules.md')
    expect(rules.startsWith('# Rules for Acme')).toBe(true)
    expect(rules.endsWith(`${entry}\n`)).toBe(true)
    const voice = appendRule('# Voice\n\n## Tone\n\nWarm.\n', '- A', 'voice.md')
    expect(voice).toContain('## Rules learned from your edits\n\n- A')
    const twice = appendRule(appendRule('# V\n\n## Rules learned from your edits\n\n- A\n\n## Not\n\nstiff\n', '- B', 'voice.md'), '- C', 'voice.md')
    expect(twice.indexOf('- B')).toBeLessThan(twice.indexOf('## Not'))
    expect(twice.indexOf('- C')).toBeLessThan(twice.indexOf('## Not'))
    expect(appendLearning('# L\n', Date.UTC(2026, 0, 2), 'kept a rule')).toBe('# L\n\n- 2026-01-02: kept a rule\n')
  })

  it('reads the friction log and skips broken lines', () => {
    const a = newEvent({ kind: 'respoken-line', projectId: 'p', before: 'Moreover it works', after: 'and it works', ref: 'l1', note: '' })
    const b = newEvent({ kind: 'rejected-suggestion', projectId: null, before: 'Title A', after: '', ref: 'c1', note: '' })
    const log = `${JSON.stringify(a)}\n{"broken\n${JSON.stringify({ ...b, kind: 'nope' })}\n${JSON.stringify(b)}\n`
    expect(parseFriction(log).map((e) => e.id)).toEqual([a.id, b.id])
    const text = frictionText([a, b])
    expect(text).toContain(`${a.id}: said a script line again, before "Moreover it works", after "and it works"`)
    expect(wrapUpPrompt([a, b], 2)).toContain('at most 2 rules')
  })
})
