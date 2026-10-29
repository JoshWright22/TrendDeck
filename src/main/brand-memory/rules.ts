import { randomUUID } from 'node:crypto'
import {
  BRAND_FILE_TITLES,
  FRICTION_KINDS,
  MAX_RULES_PER_SESSION,
  RULE_KINDS,
  RULE_TEXT_MAX,
  type BrandFileName,
  type FrictionEvent,
  type ProposedRule,
  type RuleKind
} from '@shared/brand-memory'

// the pure parts of brand memory: cleaning what the agent proposes, the per-session cap, and
// the text that goes into the brand files. no electron, the tests run it on its own

const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function cleanProposal(raw: Record<string, unknown>, known: Set<string>): ProposedRule | string {
  const text = oneLine(raw.text, RULE_TEXT_MAX + 1)
  if (!text) return 'A rule needs text.'
  if (text.length > RULE_TEXT_MAX) return `Keep a rule under ${RULE_TEXT_MAX} characters.`
  const kind = RULE_KINDS.includes(raw.kind as RuleKind) ? (raw.kind as RuleKind) : 'voice'
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).filter((e): e is string => typeof e === 'string' && known.has(e)).slice(0, 10)
  if (!evidence.length) return 'Point at the friction events this rule comes from (their ids from friction_log). A rule needs evidence.'
  const examples = (Array.isArray(raw.examples) ? raw.examples : []).map((e) => oneLine(e, 200)).filter(Boolean).slice(0, 3)
  return { id: randomUUID(), text, kind, why: oneLine(raw.why, 300), evidence, examples }
}

// at most MAX_RULES_PER_SESSION cards per wrap-up. returns how many more fit
export function rulesLeft(proposedThisSession: number): number {
  return Math.max(0, MAX_RULES_PER_SESSION - proposedThisSession)
}

export function takeProposals<T>(proposedThisSession: number, incoming: T[]): { accepted: T[]; refused: number } {
  const left = rulesLeft(proposedThisSession)
  return { accepted: incoming.slice(0, left), refused: Math.max(0, incoming.length - left) }
}

const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

export function template(file: BrandFileName, brandName: string): string {
  const title = `# ${BRAND_FILE_TITLES[file]} for ${brandName}`
  switch (file) {
    case 'rules.md':
      return `${title}\n\nRules you kept from your work with the agent. Each one says where it came from.\n`
    case 'learnings.md':
      return `${title}\n\nA running log, newest last. Nothing here is deleted.\n`
    case 'voice.md':
      return `${title}\n`
    default:
      return `${title}\n`
  }
}

export interface Provenance {
  at: number
  cardId: string
  // friction event ids
  evidence: string[]
  examples: string[]
  edited: boolean
}

// a kept rule as a markdown list item with where it came from
export function ruleEntry(text: string, kind: RuleKind, p: Provenance): string {
  const from = [`kept ${day(p.at)}`, `${kind} rule`, p.edited ? 'edited by you' : 'as proposed', `card ${p.cardId}`]
  const lines = [`- ${text.replace(/\s+/g, ' ').trim()}`, `  - ${from.join(', ')}`]
  if (p.evidence.length) lines.push(`  - from ${p.evidence.length} change${p.evidence.length === 1 ? '' : 's'}: ${p.evidence.join(', ')}`)
  for (const e of p.examples) lines.push(`  - example: ${e}`)
  return lines.join('\n')
}

const LEARNED = '## Rules learned from your edits'

// voice rules go under their own heading in voice.md, the rest at the end of rules.md
export function appendRule(md: string, entry: string, file: 'voice.md' | 'rules.md'): string {
  const base = md.replace(/\s+$/, '')
  if (file === 'rules.md') return `${base}\n\n${entry}\n`
  const i = base.indexOf(LEARNED)
  if (i < 0) return `${base}\n\n${LEARNED}\n\n${entry}\n`
  // the end of that section: the next heading of the same level, or the end
  const next = base.indexOf('\n## ', i + LEARNED.length)
  if (next < 0) return `${base}\n\n${entry}\n`
  return `${base.slice(0, next).replace(/\s+$/, '')}\n\n${entry}\n${base.slice(next)}\n`
}

export function appendLearning(md: string, at: number, text: string): string {
  return `${md.replace(/\s+$/, '')}\n\n- ${day(at)}: ${text.replace(/\s+/g, ' ').trim()}\n`
}

// ---------- the friction log ----------

export function newEvent(e: Omit<FrictionEvent, 'id' | 'at'> & { at?: number }): FrictionEvent {
  const clip = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 600)
  return { id: randomUUID().slice(0, 8), at: e.at ?? Date.now(), kind: e.kind, projectId: e.projectId, before: clip(e.before), after: clip(e.after), ref: e.ref.slice(0, 100), note: clip(e.note) }
}

export function parseFriction(text: string): FrictionEvent[] {
  const out: FrictionEvent[] = []
  for (const row of text.split('\n')) {
    if (!row.trim()) continue
    try {
      const e = JSON.parse(row) as FrictionEvent
      if (typeof e.id === 'string' && typeof e.at === 'number' && FRICTION_KINDS.includes(e.kind)) out.push(e)
    } catch {
      // a line cut short by a crash, skip it
    }
  }
  return out
}

const KIND_TEXT: Record<FrictionEvent['kind'], string> = {
  undo: 'undid an applied edit',
  'rejected-suggestion': 'said not now to a suggestion',
  'respoken-line': 'said a script line again',
  'edited-agent-line': 'rewrote a line the agent wrote',
  'removed-agent-line': 'removed a line the agent wrote',
  'take-paraphrase': 'said a line differently on camera',
  'dropped-rule': 'dropped a proposed rule',
  'edited-rule': 'edited a proposed rule before keeping it'
}

// the session's changes as the agent reads them for the wrap-up
export function frictionText(events: FrictionEvent[], max = 40): string {
  if (!events.length) return 'Nothing was changed or turned down this session.'
  return events
    .slice(-max)
    .map((e) => {
      const parts = [`${e.id}: ${KIND_TEXT[e.kind]}`]
      if (e.before) parts.push(`before "${e.before}"`)
      if (e.after) parts.push(`after "${e.after}"`)
      if (e.note) parts.push(e.note)
      return `- ${parts.join(', ')}`
    })
    .join('\n')
}

// the wrap-up message the chat sends to the agent
export function wrapUpPrompt(events: FrictionEvent[], left: number): string {
  return [
    `Let's wrap up this session. Here is what I changed or turned down since the last wrap-up (${events.length} change${events.length === 1 ? '' : 's'}):`,
    '',
    frictionText(events),
    '',
    `Look for patterns, not one-offs. Save at most ${left} rule${left === 1 ? '' : 's'} with rule_propose, each pointing at the change ids it comes from, short and in plain words (for example "Cut 'Moreover'" or "Open hooks with a story, not a stat"). They're kept right away; tell me in one line what you saved. If nothing repeats, say so and save none.`
  ].join('\n')
}
