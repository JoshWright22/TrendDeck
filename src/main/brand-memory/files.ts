import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BRAND_FILES, type BrandFileName, type RuleKind } from '@shared/brand-memory'
import { cleanProfile, emptyProfile, type CadenceProfile } from '@shared/cadence'
import { appendLearning, appendRule, ruleEntry, template, type Provenance } from './rules'

// the brand folder's readable files: positioning.md, voice.md, rules.md, learnings.md and
// cadence.json. plain node fs on a folder it's given, so tests run it on a temp folder

export const MAX_BRAND_FILE = 60_000

export function isBrandFile(name: unknown): name is BrandFileName {
  return typeof name === 'string' && (BRAND_FILES as readonly string[]).includes(name)
}

export async function readBrandFile(dir: string, name: BrandFileName): Promise<string> {
  try {
    return await fs.readFile(join(dir, name), 'utf8')
  } catch {
    return ''
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await fs.writeFile(`${path}.tmp`, text, 'utf8')
  await fs.rename(`${path}.tmp`, path)
}

export async function writeBrandFile(dir: string, name: BrandFileName, content: string): Promise<void> {
  if (content.length > MAX_BRAND_FILE) throw new Error(`Keep ${name} under ${MAX_BRAND_FILE} characters.`)
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, name), content.replace(/\r\n/g, '\n').replace(/\s*$/, '\n'))
}

// a kept rule: voice rules into voice.md, the rest into rules.md, and a line in learnings.md.
// returns the files it changed
export async function writeKeptRule(dir: string, brandName: string, text: string, kind: RuleKind, p: Provenance): Promise<BrandFileName[]> {
  const target: 'voice.md' | 'rules.md' = kind === 'voice' ? 'voice.md' : 'rules.md'
  const current = (await readBrandFile(dir, target)) || template(target, brandName)
  await writeBrandFile(dir, target, appendRule(current, ruleEntry(text, kind, p), target))
  const learnings = (await readBrandFile(dir, 'learnings.md')) || template('learnings.md', brandName)
  await writeBrandFile(dir, 'learnings.md', appendLearning(learnings, p.at, `Kept the ${kind} rule "${text}" (card ${p.cardId}${p.edited ? ', edited first' : ''}).`))
  return [target, 'learnings.md']
}

export async function appendLearningLine(dir: string, brandName: string, at: number, text: string): Promise<void> {
  const learnings = (await readBrandFile(dir, 'learnings.md')) || template('learnings.md', brandName)
  await writeBrandFile(dir, 'learnings.md', appendLearning(learnings, at, text))
}

export async function readCadence(dir: string): Promise<CadenceProfile> {
  try {
    return cleanProfile(JSON.parse(await fs.readFile(join(dir, 'cadence.json'), 'utf8')))
  } catch {
    return emptyProfile()
  }
}

export async function writeCadence(dir: string, p: CadenceProfile): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  // rounded and sorted keys so git diffs stay readable
  await writeAtomic(join(dir, 'cadence.json'), `${JSON.stringify(p, null, 1)}\n`)
}

// the brand files as the agent sees them every turn, each cut to its share of the budget
export function memoryBlock(files: Partial<Record<BrandFileName, string>>, cadence: string, maxChars = 3000): string {
  const parts: string[] = []
  let left = maxChars
  const add = (title: string, body: string, share: number): void => {
    const text = body.replace(/^# .*\n/, '').trim()
    if (!text || left < 80) return
    const room = Math.min(left, Math.floor(maxChars * share))
    const cut = text.length > room ? `${text.slice(0, Math.max(0, room - 40)).replace(/\s+\S*$/, '')}\n(cut short, read it with brand_files_read)` : text
    parts.push(`## ${title}\n${cut}`)
    left -= cut.length + title.length + 4
  }
  add('Brand positioning (brand/positioning.md)', files['positioning.md'] ?? '', 0.25)
  add('Voice guide (brand/voice.md)', files['voice.md'] ?? '', 0.45)
  if (cadence && left > cadence.length) {
    parts.push(cadence)
    left -= cadence.length
  }
  return parts.join('\n\n')
}
