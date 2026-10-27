import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSample, analyzeWords, emptyProfile } from '@shared/cadence'
import { memoryBlock, readBrandFile, readCadence, writeBrandFile, writeCadence, writeKeptRule } from './files'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'td-brand-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('brand files', () => {
  it('writes kept rules with provenance into the brand folder', async () => {
    const dir = temp()
    const at = Date.UTC(2026, 9, 26)
    const changed = await writeKeptRule(dir, 'Acme', "Cut 'Moreover'", 'voice', { at, cardId: 'card1', evidence: ['e1'], examples: [], edited: false })
    expect(changed).toEqual(['voice.md', 'learnings.md'])
    const voice = await readBrandFile(dir, 'voice.md')
    expect(voice).toContain('# Voice guide for Acme')
    expect(voice).toContain("## Rules learned from your edits\n\n- Cut 'Moreover'\n  - kept 2026-10-26, voice rule, as proposed, card card1")
    await writeKeptRule(dir, 'Acme', 'Hooks open with a story', 'structure', { at, cardId: 'card2', evidence: ['e2'], examples: [], edited: true })
    expect(await readBrandFile(dir, 'rules.md')).toContain('- Hooks open with a story')
    const learnings = await readBrandFile(dir, 'learnings.md')
    expect(learnings.match(/^- 2026-10-26/gm)).toHaveLength(2)
    expect(learnings).toContain('edited first')
  })

  it('normalizes line endings and refuses huge files', async () => {
    const dir = temp()
    await writeBrandFile(dir, 'positioning.md', '# P\r\n\r\nFor busy parents.   ')
    expect(await readFile(join(dir, 'positioning.md'), 'utf8')).toBe('# P\n\nFor busy parents.\n')
    await expect(writeBrandFile(dir, 'positioning.md', 'x'.repeat(70_000))).rejects.toThrow(/under/)
  })

  it('keeps the cadence profile as readable json', async () => {
    const dir = temp()
    expect(await readCadence(dir)).toEqual(emptyProfile())
    const p = addSample(emptyProfile(), analyzeWords([{ text: 'hello', start: 0, end: 0.3 }, { text: 'there.', start: 0.4, end: 0.7 }]), 5)
    await writeCadence(dir, p)
    expect(await readCadence(dir)).toEqual(p)
  })

  it('caps the per-turn block', () => {
    const block = memoryBlock({ 'voice.md': `# V\n\n${'warm and direct. '.repeat(400)}`, 'positioning.md': '# P\n\nFor busy parents.' }, '## How the creator talks\n- fast', 1500)
    expect(block.length).toBeLessThanOrEqual(1500)
    expect(block).toContain('For busy parents.')
    expect(block).toContain('cut short')
    expect(block).toContain('How the creator talks')
    expect(memoryBlock({}, '')).toBe('')
  })
})
