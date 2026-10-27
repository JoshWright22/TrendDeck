import { describe, expect, it } from 'vitest'
import { accountId, baseAgentId, isAccountId, rankedIds, skippedLine } from './agents'

describe('agent ids', () => {
  it('accounts run their base cli', () => {
    expect(baseAgentId('claude@work')).toBe('claude')
    expect(baseAgentId('codex')).toBe('codex')
    expect(baseAgentId('custom-abc')).toBe('custom-abc')
  })
  it('only claude and codex take accounts', () => {
    expect(isAccountId('claude@work')).toBe(true)
    expect(isAccountId('codex@two-2')).toBe(true)
    expect(isAccountId('cursor@work')).toBe(false)
    expect(isAccountId('claude@')).toBe(false)
    expect(isAccountId('claude@Bad Name')).toBe(false)
    expect(isAccountId('claude')).toBe(false)
  })
  it('makes a free id from the name', () => {
    expect(accountId('claude', 'Claude 2', [])).toBe('claude@claude-2')
    expect(accountId('claude', 'Claude 2', ['claude@claude-2'])).toBe('claude@claude-2-2')
    expect(accountId('codex', '!!!', [])).toBe('codex@account')
    expect(isAccountId(accountId('claude', 'Work account', []))).toBe(true)
  })
  it('ranked first, the rest after', () => {
    expect(rankedIds(['claude', 'codex', 'claude@two'], ['claude@two'])).toEqual(['claude@two', 'claude', 'codex'])
  })
})

describe('skippedLine', () => {
  const names: Record<string, string> = { 'claude@two': 'Claude 2', claude: 'Claude Code' }
  const nameOf = (id: string): string => names[id] ?? id
  it('says who couldn\'t and who answered', () => {
    expect(skippedLine([{ agentId: 'claude@two', reason: 'usage_limit' }], 'Codex', nameOf)).toBe('Claude 2 hit its usage limit, Codex answered')
    expect(
      skippedLine(
        [
          { agentId: 'claude@two', reason: 'rate_limit' },
          { agentId: 'claude', reason: 'auth' }
        ],
        'Codex',
        nameOf,
        true
      )
    ).toBe("Claude 2 was rate limited, Claude Code wasn't signed in, Codex is answering")
  })
})
