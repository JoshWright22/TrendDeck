import type { SkippedAgent, SkipReason } from './chat'

// agent ids shared by main and the window: auto, and extra accounts of a builtin cli

export const AUTO_AGENT = 'auto'

// the clis that can have more than one account, and the env var that points at its folder
export const ACCOUNT_ENV: Record<string, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

// claude@work -> claude, anything else stays as it is
export function baseAgentId(id: string): string {
  const at = id.indexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

export function isAccountId(id: string): boolean {
  const at = id.indexOf('@')
  return at > 0 && id.slice(0, at) in ACCOUNT_ENV && /^[a-z0-9-]{1,40}$/.test(id.slice(at + 1))
}

export function accountId(base: string, name: string, taken: string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'account'
  let id = `${base}@${slug}`
  for (let n = 2; taken.includes(id); n++) id = `${base}@${slug}-${n}`
  return id
}

// every agent in the order auto tries them: the ranked ones first, the rest in the usual order
export function rankedIds(allIds: string[], rank: string[]): string[] {
  const known = new Set(allIds)
  const first = [...new Set(rank)].filter((id) => known.has(id))
  return [...first, ...allIds.filter((id) => !first.includes(id))]
}

const SKIP_WORDS: Record<SkipReason, string> = {
  rate_limit: 'was rate limited',
  usage_limit: 'hit its usage limit',
  auth: "wasn't signed in"
}

// "Claude 2 hit its usage limit, Codex answered"
export function skippedLine(skipped: SkippedAgent[], answeredBy: string, nameOf: (id: string) => string, running = false): string {
  const parts = skipped.map((s) => `${nameOf(s.agentId)} ${SKIP_WORDS[s.reason]}`)
  return [...parts, `${answeredBy} ${running ? 'is answering' : 'answered'}`].join(', ')
}
