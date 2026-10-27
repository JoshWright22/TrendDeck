import { describe, expect, it } from 'vitest'
import {
  blockedFor,
  classifyAgentError,
  cooldownFor,
  limitReply,
  noneLeftMessage,
  pickAgent,
  plainError,
  rankedIds,
  resetFrom,
  type PickInput
} from './route'

const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime()
const MIN = 60_000
const HOUR = 60 * MIN

describe('classifyAgentError', () => {
  it.each([
    ['Claude AI usage limit reached|1761580000', 'usage_limit'],
    ['usage limit reached', 'usage_limit'],
    ["You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again in 2 days 3 hours 4 minutes.", 'usage_limit'],
    ["You've hit your limit · resets 3am (America/New_York)", 'usage_limit'],
    ['5-hour limit reached ∙ resets 4pm', 'usage_limit'],
    ['Weekly limit reached', 'usage_limit'],
    ['Credit balance is too low', 'usage_limit'],
    ['You exceeded your current quota, please check your plan and billing details. insufficient_quota', 'usage_limit'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', 'rate_limit'],
    ['rate limit', 'rate_limit'],
    ['Rate limited, try again later', 'rate_limit'],
    ['stream disconnected before completion: exceeded retry limit, last status: 429 Too Many Requests', 'rate_limit'],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'rate_limit'],
    ['Invalid API key · Please run /login', 'auth'],
    ['Please run /login', 'auth'],
    ['Not logged in. Run codex login', 'auth'],
    ['You are not signed in', 'auth'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}', 'auth'],
    ['API Error: 403 {"error":{"type":"permission_error"}}', 'auth'],
    ['unexpected status 401 Unauthorized', 'auth'],
    ['The agent quit with code 1', 'other'],
    ['That agent was removed. Pick another one.', 'other'],
    ['Error on line 4290', 'other'],
    ['', 'other']
  ])('%s', (text, kind) => {
    expect(classifyAgentError(text)).toBe(kind)
  })
})

describe('limitReply', () => {
  it('spots whole replies that are only a limit notice', () => {
    expect(limitReply('Claude AI usage limit reached|1761580000')).toBe('usage_limit')
    expect(limitReply('Invalid API key · Please run /login')).toBe('auth')
    expect(limitReply('API Error: 429 rate_limit_error')).toBe('rate_limit')
  })
  it('leaves real answers alone', () => {
    expect(limitReply('A rate limit is how many requests you can send in a minute.')).toBe('other')
    expect(limitReply('Usage limit reached is what the error says.\n\nHere is why it happens and how to fix it.')).toBe('other')
  })
})

describe('resetFrom', () => {
  it('reads an epoch after a pipe, seconds or ms', () => {
    const at = NOW + 3 * HOUR
    expect(resetFrom(`Claude AI usage limit reached|${Math.floor(at / 1000)}`, NOW)).toBe(Math.floor(at / 1000) * 1000)
    expect(resetFrom(`usage limit reached|${at}`, NOW)).toBe(at)
  })
  it('ignores an epoch in the past', () => {
    expect(resetFrom(`usage limit reached|${Math.floor((NOW - HOUR) / 1000)}`, NOW)).toBeNull()
  })
  it('reads try again in', () => {
    expect(resetFrom('try again in 2 days 3 hours 4 minutes.', NOW)).toBe(NOW + 2 * 24 * HOUR + 3 * HOUR + 4 * MIN)
    expect(resetFrom('Try again in 4h 10m', NOW)).toBe(NOW + 4 * HOUR + 10 * MIN)
    expect(resetFrom('retry in 30s', NOW)).toBe(NOW + 30_000)
    expect(resetFrom('resets in 45 minutes', NOW)).toBe(NOW + 45 * MIN)
  })
  it('reads a clock time, the next time it comes round', () => {
    expect(resetFrom('resets at 4:10 PM', NOW)).toBe(new Date(2026, 9, 27, 16, 10).getTime())
    expect(resetFrom('Your limit will reset at 5pm (America/New_York).', NOW)).toBe(new Date(2026, 9, 27, 17, 0).getTime())
    expect(resetFrom("You've hit your limit · resets 3am", NOW)).toBe(new Date(2026, 9, 28, 3, 0).getTime())
    expect(resetFrom('try again at 11:30', NOW)).toBe(new Date(2026, 9, 28, 11, 30).getTime())
  })
  it('null when there is nothing to go on', () => {
    expect(resetFrom('rate limit', NOW)).toBeNull()
    expect(resetFrom('resets soon', NOW)).toBeNull()
  })
})

describe('cooldownFor', () => {
  it('uses the reset in the text when there is one', () => {
    expect(cooldownFor('usage_limit', 'try again in 2h', NOW).until).toBe(NOW + 2 * HOUR)
  })
  it('falls back to 15 minutes, 5 hours, or until checked again', () => {
    expect(cooldownFor('rate_limit', 'rate limit', NOW).until).toBe(NOW + 15 * MIN)
    expect(cooldownFor('usage_limit', 'usage limit reached', NOW).until).toBe(NOW + 5 * HOUR)
    expect(cooldownFor('auth', 'Please run /login', NOW).until).toBeNull()
  })
})

describe('blockedFor', () => {
  const ok = { id: 'claude', installed: true, signedIn: true }
  it('is free when nothing is in the way', () => {
    expect(blockedFor(ok, [], undefined, NOW)).toBeNull()
    expect(blockedFor({ ...ok, signedIn: null }, [], undefined, NOW)).toBeNull()
  })
  it('missing and signed out', () => {
    expect(blockedFor({ ...ok, installed: false }, [], undefined, NOW)?.why).toBe('missing')
    expect(blockedFor({ ...ok, signedIn: false }, [], undefined, NOW)?.why).toBe('signed_out')
  })
  it('a full window that has not reset yet', () => {
    const w = { label: '5 hour limit', used: 1, resetsAt: NOW + HOUR }
    expect(blockedFor(ok, [w], undefined, NOW)).toEqual({ why: 'limit', until: NOW + HOUR })
    expect(blockedFor(ok, [{ ...w, resetsAt: NOW - 1 }], undefined, NOW)).toBeNull()
    expect(blockedFor(ok, [{ ...w, used: 0.99 }], undefined, NOW)).toBeNull()
    expect(blockedFor(ok, [{ ...w, resetsAt: null }], undefined, NOW)).toBeNull()
  })
  it('a cooldown until it runs out', () => {
    const c = { kind: 'rate_limit' as const, until: NOW + MIN, at: NOW }
    expect(blockedFor(ok, [], c, NOW)).toEqual({ why: 'rate_limit', until: NOW + MIN })
    expect(blockedFor(ok, [], c, NOW + 2 * MIN)).toBeNull()
    expect(blockedFor(ok, [], { kind: 'auth', until: null, at: NOW }, NOW + 99 * HOUR)).toEqual({ why: 'auth', until: null })
  })
})

describe('pickAgent', () => {
  const base = (over: Partial<PickInput> = {}): PickInput => ({
    agents: [
      { id: 'claude', installed: true, signedIn: true },
      { id: 'claude@two', installed: true, signedIn: true },
      { id: 'codex', installed: true, signedIn: true },
      { id: 'grok', installed: false, signedIn: null }
    ],
    rank: ['claude@two', 'codex', 'claude'],
    autoOff: [],
    usage: {},
    cooldowns: {},
    now: NOW,
    ...over
  })

  it('ranked ones first, then the rest in the usual order', () => {
    expect(rankedIds(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd'])
  })
  it('takes the top ranked one', () => {
    expect(pickAgent(base()).agentId).toBe('claude@two')
  })
  it('skips agents turned off for auto', () => {
    expect(pickAgent(base({ autoOff: ['claude@two'] })).agentId).toBe('codex')
  })
  it('moves on past limits, cooldowns and sign outs', () => {
    const p = pickAgent(
      base({
        usage: { 'claude@two': [{ label: 'Weekly limit', used: 1, resetsAt: NOW + HOUR }] },
        cooldowns: { codex: { kind: 'usage_limit', until: NOW + 2 * HOUR, at: NOW } }
      })
    )
    expect(p.agentId).toBe('claude')
    expect(p.blocked.map((b) => b.agentId)).toEqual(['claude@two', 'codex'])
    const signedOut = pickAgent(base({ agents: base().agents.map((a) => (a.id === 'claude@two' ? { ...a, signedIn: false } : a)) }))
    expect(signedOut.agentId).toBe('codex')
  })
  it('skips the ones already tried for this reply', () => {
    expect(pickAgent(base({ exclude: ['claude@two', 'codex'] })).agentId).toBe('claude')
  })
  it('null when nobody is left, with the earliest one back', () => {
    const p = pickAgent(
      base({
        cooldowns: {
          'claude@two': { kind: 'usage_limit', until: NOW + 4 * HOUR + 10 * MIN, at: NOW },
          codex: { kind: 'usage_limit', until: NOW + 5 * HOUR, at: NOW },
          claude: { kind: 'auth', until: null, at: NOW }
        }
      })
    )
    expect(p.agentId).toBeNull()
    const msg = noneLeftMessage(p, [], (id) => (id === 'claude@two' ? 'Claude 2' : id), NOW)
    expect(msg).toBe('All your agents are at their limits. Claude 2 is back at 4:10 PM.')
  })
  it('says so when auto has nothing turned on', () => {
    const p = pickAgent(base({ autoOff: ['claude', 'claude@two', 'codex', 'grok'] }))
    expect(p.enabled).toBe(0)
    expect(noneLeftMessage(p, [], (id) => id, NOW)).toMatch(/no agents to use/)
  })
})

describe('plainError', () => {
  it('words per kind', () => {
    expect(plainError('auth', 'Claude 2', null, NOW)).toMatch(/^Claude 2 can't be used right now/)
    expect(plainError('usage_limit', 'Codex', NOW + HOUR, NOW)).toMatch(/^Codex hit its usage limit. It's back at 1:00 PM/)
    expect(plainError('rate_limit', 'Codex', null, NOW)).toMatch(/^Codex is rate limited. Try again in a few minutes/)
  })
})

describe('more claude code wordings', () => {
  it('reads a session limit and an organization that turned access off', () => {
    expect(classifyAgentError("You've hit your session limit · resets 2:40am (America/Los_Angeles)")).toBe('usage_limit')
    expect(classifyAgentError('Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access')).toBe('auth')
  })
})

