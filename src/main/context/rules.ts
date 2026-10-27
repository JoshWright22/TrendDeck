import { randomUUID } from 'node:crypto'
import { STYLE_RULE_CHARS, STYLE_RULE_MAX, STYLE_WHY_CHARS, type StyleRule } from '@shared/context'

// style rules per brand. pure, no electron, so the tests can run it on its own

export type RuleResult = { ok: true; rules: StyleRule[]; rule: StyleRule } | { ok: false; error: string }

// trimmed with whitespace collapsed, '' for anything that isn't text
export function cleanRule(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

function checkText(rules: StyleRule[], text: string, skipId?: string): string | null {
  if (!text) return "A rule can't be empty."
  if (text.length > STYLE_RULE_CHARS) return `Keep a rule under ${STYLE_RULE_CHARS} characters, this one has ${text.length}.`
  const lower = text.toLowerCase()
  if (rules.some((r) => r.id !== skipId && r.text.toLowerCase() === lower)) return 'That rule is already saved.'
  return null
}

export function addRule(
  rules: StyleRule[],
  raw: unknown,
  source: StyleRule['source'],
  opts: { why?: unknown; now?: number; id?: string } = {}
): RuleResult {
  const text = cleanRule(raw)
  const bad = checkText(rules, text)
  if (bad) return { ok: false, error: bad }
  if (rules.length >= STYLE_RULE_MAX) {
    return { ok: false, error: `You already have ${STYLE_RULE_MAX} rules for this brand. Delete one first.` }
  }
  const why = cleanRule(opts.why).slice(0, STYLE_WHY_CHARS)
  const rule: StyleRule = { id: opts.id ?? randomUUID(), text, createdAt: opts.now ?? Date.now(), source, ...(why ? { why } : {}) }
  return { ok: true, rules: [...rules, rule], rule }
}

export function editRule(rules: StyleRule[], id: string, raw: unknown): RuleResult {
  const old = rules.find((r) => r.id === id)
  if (!old) return { ok: false, error: 'That rule is gone.' }
  const text = cleanRule(raw)
  const bad = checkText(rules, text, id)
  if (bad) return { ok: false, error: bad }
  const rule: StyleRule = { ...old, text }
  return { ok: true, rules: rules.map((r) => (r.id === id ? rule : r)), rule }
}

export function removeRule(rules: StyleRule[], id: string): StyleRule[] {
  return rules.filter((r) => r.id !== id)
}

// whatever was on disk, kept only if it still looks like a rule
export function cleanRules(raw: unknown): StyleRule[] {
  if (!Array.isArray(raw)) return []
  const out: StyleRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const x = r as Partial<StyleRule>
    const text = cleanRule(x.text)
    if (typeof x.id !== 'string' || !x.id || !text || text.length > STYLE_RULE_CHARS) continue
    if (out.some((o) => o.id === x.id || o.text.toLowerCase() === text.toLowerCase())) continue
    const why = cleanRule(x.why).slice(0, STYLE_WHY_CHARS)
    out.push({
      id: x.id,
      text,
      createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0,
      source: x.source === 'agent' ? 'agent' : 'user',
      ...(why ? { why } : {})
    })
    if (out.length >= STYLE_RULE_MAX) break
  }
  return out
}

const HEADING = '## Style rules the user confirmed'
const leftOut = (n: number): string => `(${n} older ${n === 1 ? 'rule' : 'rules'} left out)`

// the block that goes into the agent's context each turn, newest first, at most maxChars long.
// once a rule doesn't fit, it and everything older is left out and counted on the last line
export function styleBlock(rules: StyleRule[], maxChars = 2500): string {
  if (!rules.length) return ''
  const sorted = [...rules].sort((a, b) => b.createdAt - a.createdAt)
  const lines = sorted.map((r) => `- ${cleanRule(r.text)}`)
  const full = [HEADING, ...lines].join('\n')
  if (full.length <= maxChars) return full
  // room for the note at the end, sized for the most it could say
  const reserve = 1 + leftOut(sorted.length).length
  let used = HEADING.length
  let kept = 0
  for (const line of lines) {
    if (used + 1 + line.length + reserve > maxChars) break
    used += 1 + line.length
    kept++
  }
  if (!kept && HEADING.length + reserve > maxChars) return ''
  return [HEADING, ...lines.slice(0, kept), leftOut(sorted.length - kept)].join('\n')
}
