import type { SkipReason, UsageWindow } from '@shared/chat'
import { rankedIds } from '@shared/agents'

export { rankedIds }

// auto routing: which ranked agent answers, and what an agent's error means. no electron and
// no disk in here so it can be tested on its own

export type ErrorKind = SkipReason | 'other'

const USAGE: RegExp[] = [
  /usage limit/i,
  /hit your (usage |session |weekly |daily )?limit/i,
  /session limit/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /exceeded your current quota/i,
  /quota exceeded/i,
  /out of (credits|usage)/i
]

const AUTH: RegExp[] = [
  /\/login\b/i,
  /\b(codex|claude) login\b/i,
  /invalid api key/i,
  /invalid[_ ]x-api-key/i,
  /\bnot (logged|signed) in\b/i,
  /\blogged out\b/i,
  /\bplease (log|sign) in\b/i,
  /\b40[13]\b/,
  /\bunauthori[sz]ed\b/i,
  /authentication[_ ](error|failed)/i,
  /\b(oauth )?token (has )?(expired|been revoked)\b/i,
  /\bforbidden\b/i,
  // the account can't use claude code at all, e.g. its organization turned subscription access off
  /disabled (claude )?subscription access/i,
  /use an anthropic api key instead/i
]

const RATE: RegExp[] = [/rate[ _-]?limit/i, /\b429\b/, /too many requests/i, /\boverloaded\b/i, /\b529\b/]

// limit words that only mean usage once rate limits are ruled out
const WEAK_USAGE: RegExp[] = [/\blimit reached\b/i, /\b(weekly|daily|monthly|\d+-hour|five hour) limit\b/i]

// what kind of failure an agent's error text is
export function classifyAgentError(text: string): ErrorKind {
  const t = String(text ?? '').slice(0, 4000)
  if (!t.trim()) return 'other'
  if (USAGE.some((r) => r.test(t))) return 'usage_limit'
  if (RATE.some((r) => r.test(t))) return 'rate_limit'
  if (WEAK_USAGE.some((r) => r.test(t))) return 'usage_limit'
  if (AUTH.some((r) => r.test(t))) return 'auth'
  return 'other'
}

// a whole reply that is only a limit or login notice, the way claude code sometimes prints them
export function limitReply(text: string): ErrorKind {
  const t = text.trim()
  if (!t || t.length > 300 || t.includes('\n\n')) return 'other'
  if (
    /^(claude ai )?usage limit reached/i.test(t) ||
    /^you'?ve hit your (usage )?limit/i.test(t) ||
    /^\d+-hour limit reached/i.test(t) ||
    /^(weekly|daily) limit reached/i.test(t) ||
    /^credit balance is too low/i.test(t) ||
    /^invalid api key/i.test(t) ||
    /^please run \/login/i.test(t) ||
    /^api error: (401|403|429)\b/i.test(t)
  ) {
    return classifyAgentError(t)
  }
  return 'other'
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }

function unitOf(word: string): number | null {
  const w = word.toLowerCase()
  if (w.startsWith('d')) return UNIT_MS.d
  if (w.startsWith('h')) return UNIT_MS.h
  if (w.startsWith('mo')) return null
  if (w.startsWith('m')) return UNIT_MS.m
  if (w.startsWith('s')) return UNIT_MS.s
  return null
}

// next time the clock shows h:mm, local time
function nextClock(now: number, hour: number, minute: number): number {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// when the limit in the error text lifts, when it says
export function resetFrom(text: string, now: number): number | null {
  const t = String(text ?? '')
  // claude code: "Claude AI usage limit reached|1760000000"
  const epoch = /\|\s*(\d{10,13})\b/.exec(t)
  if (epoch) {
    const n = Number(epoch[1])
    const ms = n < 1e12 ? n * 1000 : n
    if (ms > now) return ms
  }
  // "try again in 2 days 3 hours", "resets in 4h 10m", "retry in 30s"
  const rel = /\b(?:try again|retry|resets?|available again|back)\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(t)
  if (rel) {
    let ms = 0
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const unit = unitOf(m[2])
      if (unit) ms += Number(m[1]) * unit
    }
    if (ms > 0) return now + Math.round(ms)
  }
  // "resets at 4:10 PM", "will reset at 5pm (America/New_York)", "try again at 16:30", "resets 3am"
  const at = /\b(?:resets?|try again|available again|back)\s+(?:at\s+|on\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(t)
  if (at && (at[2] || at[3])) {
    let hour = Number(at[1])
    const minute = at[2] ? Number(at[2]) : 0
    const ampm = at[3]?.toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (hour < 24 && minute < 60) return nextClock(now, hour, minute)
  }
  // "resets at 2026-10-27T16:10:00Z"
  const iso = /\b(?:resets?|try again|available again)\s+(?:at\s+|on\s+)?(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)/i.exec(t)
  if (iso) {
    const ms = Date.parse(iso[1])
    if (ms > now) return ms
  }
  return null
}

export interface Cooldown {
  kind: SkipReason
  // null: until the agents are checked again (signed out)
  until: number | null
  at: number
}

const RATE_COOLDOWN_MS = 15 * 60_000
const USAGE_COOLDOWN_MS = 5 * 3_600_000

// how long auto leaves an agent alone after a failure like this
export function cooldownFor(kind: SkipReason, text: string, now: number): Cooldown {
  const reset = kind === 'auth' ? null : resetFrom(text, now)
  const until = kind === 'auth' ? null : (reset ?? now + (kind === 'rate_limit' ? RATE_COOLDOWN_MS : USAGE_COOLDOWN_MS))
  return { kind, until, at: now }
}

export function liveCooldown(c: Cooldown | undefined, now: number): Cooldown | undefined {
  if (!c) return undefined
  return c.until === null || c.until > now ? c : undefined
}

export interface RouteAgent {
  id: string
  installed: boolean
  signedIn?: boolean | null
}

export type Blocked = 'missing' | 'signed_out' | 'limit' | SkipReason

export interface BlockedAgent {
  agentId: string
  why: Blocked
  // when it's back, null when that's unknown or up to the user
  until: number | null
}

// why an agent can't answer right now, null when it can
export function blockedFor(
  agent: RouteAgent,
  windows: UsageWindow[] | undefined,
  cooldown: Cooldown | undefined,
  now: number
): Omit<BlockedAgent, 'agentId'> | null {
  if (!agent.installed) return { why: 'missing', until: null }
  if (agent.signedIn === false) return { why: 'signed_out', until: null }
  const full = (windows ?? []).filter((w) => w.used !== null && w.used >= 1 && w.resetsAt !== null && w.resetsAt > now)
  const c = liveCooldown(cooldown, now)
  const untils = [...full.map((w) => w.resetsAt as number), ...(c?.until ? [c.until] : [])]
  if (c?.until === null) return { why: c.kind, until: null }
  if (!untils.length) return null
  // both a full window and a cooldown: it's back when the later one lifts
  return { why: c ? c.kind : 'limit', until: Math.max(...untils) }
}

export interface PickInput {
  agents: RouteAgent[]
  rank: string[]
  autoOff: string[]
  usage: Record<string, UsageWindow[] | undefined>
  cooldowns: Record<string, Cooldown | undefined>
  now: number
  // already tried for this reply
  exclude?: string[]
}

export interface Pick {
  agentId: string | null
  // the ones before it that couldn't answer, in rank order
  blocked: BlockedAgent[]
  // how many agents auto may use at all
  enabled: number
}

export function pickAgent(input: PickInput): Pick {
  const byId = new Map(input.agents.map((a) => [a.id, a]))
  const order = rankedIds(
    input.agents.map((a) => a.id),
    input.rank
  ).filter((id) => !input.autoOff.includes(id))
  const blocked: BlockedAgent[] = []
  for (const id of order) {
    if (input.exclude?.includes(id)) continue
    const why = blockedFor(byId.get(id)!, input.usage[id], input.cooldowns[id], input.now)
    if (!why) return { agentId: id, blocked, enabled: order.length }
    blocked.push({ agentId: id, ...why })
  }
  return { agentId: null, blocked, enabled: order.length }
}

export const clockTime = (at: number, now: number): string => {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (at - now < 20 * 3_600_000) return time
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

// what the reply says when auto has nobody left
export function noneLeftMessage(
  pick: Pick,
  tried: { agentId: string; until: number | null }[],
  nameOf: (id: string) => string,
  now: number,
  fmt: (at: number, now: number) => string = clockTime
): string {
  if (!pick.enabled) return 'Auto has no agents to use. Turn one on in Settings, Agents.'
  const all = [...tried, ...pick.blocked]
  const back = all.filter((b) => b.until !== null && b.until > now).sort((a, b) => (a.until as number) - (b.until as number))[0]
  if (back) return `All your agents are at their limits. ${nameOf(back.agentId)} is back at ${fmt(back.until as number, now)}.`
  if (pick.blocked.some((b) => b.why === 'signed_out' || b.why === 'auth')) {
    return "None of your agents can answer right now. Sign in to one in Settings, Agents, then check again."
  }
  return 'None of your agents can answer right now.'
}

// the plain error for a chat pinned to one agent
export function plainError(
  kind: SkipReason,
  name: string,
  until: number | null,
  now: number,
  fmt: (at: number, now: number) => string = clockTime
): string {
  const when = until && until > now ? ` It's back at ${fmt(until, now)}.` : ''
  if (kind === 'auth') return `${name} can't be used right now: it's signed out or its account doesn't allow it. Sign in again, or add another account, in Settings, Agents. Or pick Auto.`
  if (kind === 'usage_limit') return `${name} hit its usage limit.${when || ' Try again later.'} Or pick another agent, or Auto.`
  return `${name} is rate limited.${when || ' Try again in a few minutes.'} Or pick another agent, or Auto.`
}
