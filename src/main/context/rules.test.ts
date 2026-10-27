import { describe, expect, it } from 'vitest'
import { STYLE_RULE_CHARS, STYLE_RULE_MAX, type StyleRule } from '@shared/context'
import { addRule, cleanRule, cleanRules, editRule, removeRule, styleBlock } from './rules'

const rule = (text: string, createdAt: number, id = `r${createdAt}`): StyleRule => ({ id, text, createdAt, source: 'user' })

describe('cleanRule and addRule', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanRule('  Cut   every\n pause\tlonger than 0.4 s  ')).toBe('Cut every pause longer than 0.4 s')
    expect(cleanRule(42)).toBe('')
    const r = addRule([], '  Never use   "insane"  ', 'agent', { why: '  it reads  as clickbait ', now: 5, id: 'a' })
    expect(r).toEqual({
      ok: true,
      rules: [{ id: 'a', text: 'Never use "insane"', createdAt: 5, source: 'agent', why: 'it reads as clickbait' }],
      rule: { id: 'a', text: 'Never use "insane"', createdAt: 5, source: 'agent', why: 'it reads as clickbait' }
    })
  })

  it('refuses empty rules', () => {
    expect(addRule([], '   \n ', 'user').ok).toBe(false)
    expect(addRule([], null, 'user').ok).toBe(false)
  })

  it('refuses exact duplicates, case-insensitive', () => {
    const rules = [rule('Cut every pause', 1)]
    const r = addRule(rules, '  cut EVERY   pause ', 'agent')
    expect(r.ok).toBe(false)
    expect(addRule(rules, 'Cut every pause longer than 1 s', 'agent').ok).toBe(true)
  })

  it('caps characters per rule', () => {
    expect(addRule([], 'a'.repeat(STYLE_RULE_CHARS), 'user').ok).toBe(true)
    const r = addRule([], 'a'.repeat(STYLE_RULE_CHARS + 1), 'user')
    expect(r.ok).toBe(false)
    // whitespace is collapsed before counting
    expect(addRule([], `${'a '.repeat(140)}     `, 'user').ok).toBe(true)
  })

  it('caps the number of rules', () => {
    let rules: StyleRule[] = []
    for (let i = 0; i < STYLE_RULE_MAX; i++) {
      const r = addRule(rules, `rule ${i}`, 'user')
      if (!r.ok) throw new Error(r.error)
      rules = r.rules
    }
    expect(rules).toHaveLength(STYLE_RULE_MAX)
    const over = addRule(rules, 'one more', 'user')
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toMatch(/40/)
  })

  it('edits and removes', () => {
    const rules = [rule('One', 1, 'a'), rule('Two', 2, 'b')]
    const e = editRule(rules, 'a', '  One  more ')
    expect(e.ok && e.rules.map((r) => r.text)).toEqual(['One more', 'Two'])
    expect(editRule(rules, 'a', 'two').ok).toBe(false)
    // the same rule with new case is fine
    expect(editRule(rules, 'a', 'ONE').ok).toBe(true)
    expect(editRule(rules, 'nope', 'x').ok).toBe(false)
    expect(removeRule(rules, 'a').map((r) => r.id)).toEqual(['b'])
  })

  it('cleans rules read from disk', () => {
    const out = cleanRules([rule('A', 1, 'a'), { id: 'b', text: '' }, rule('a', 2, 'c'), 'junk', { id: 'd', text: ' B ', source: 'agent' }])
    expect(out.map((r) => [r.id, r.text, r.source])).toEqual([
      ['a', 'A', 'user'],
      ['d', 'B', 'agent']
    ])
    expect(cleanRules(null)).toEqual([])
  })
})

describe('styleBlock', () => {
  it('is empty with no rules', () => {
    expect(styleBlock([])).toBe('')
  })

  it('lists rules newest first under the heading', () => {
    const out = styleBlock([rule('Old rule', 1), rule('New rule', 3), rule('Middle rule', 2)])
    expect(out).toBe('## Style rules the user confirmed\n- New rule\n- Middle rule\n- Old rule')
  })

  it('stays under the cap and says how many older rules were left out', () => {
    const rules = Array.from({ length: 40 }, (_, i) => rule(`${String(i).padStart(2, '0')} ${'x'.repeat(270)}`, i))
    const out = styleBlock(rules)
    expect(out.length).toBeLessThanOrEqual(2500)
    const lines = out.split('\n')
    expect(lines[0]).toBe('## Style rules the user confirmed')
    const kept = lines.filter((l) => l.startsWith('- '))
    expect(kept.length).toBeGreaterThan(0)
    // newest first, and only the oldest ones dropped
    expect(kept[0].startsWith('- 39 ')).toBe(true)
    expect(lines[lines.length - 1]).toBe(`(${40 - kept.length} older rules left out)`)
  })

  it('honors a small cap', () => {
    const rules = [rule('a'.repeat(50), 1), rule('b'.repeat(50), 2)]
    const out = styleBlock(rules, 120)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).toContain('b'.repeat(50))
    expect(out).not.toContain('a'.repeat(50))
    expect(out.endsWith('(1 older rule left out)')).toBe(true)
    expect(styleBlock(rules, 10)).toBe('')
  })
})
