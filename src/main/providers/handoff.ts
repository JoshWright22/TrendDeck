import type { Thread, ThreadMessage } from '@shared/chat'
import { turnText } from '../agents/context'

// when a thread moves to another agent mid chat, the new one gets a plain text summary of
// the turns it never saw: who answered, what they said, what tools they used, the plan.
// same idea when an agent with a saved session comes back after others answered

const MAX_TURN_CHARS = 3_000
const MAX_STEPS = 8

export interface Handoff {
  text: string
  // the other agents whose turns are in it
  from: string[]
}

function stepsLine(m: ThreadMessage): string {
  const steps = (m.steps ?? []).filter((s) => s.status !== 'error').slice(0, MAX_STEPS)
  if (!steps.length) return ''
  return `(used: ${steps.map((s) => (s.detail ? `${s.label}: ${s.detail}` : s.label)).join('; ')})`
}

function planLines(m: ThreadMessage): string[] {
  if (!m.plan?.length) return []
  const mark = { done: 'x', 'in-progress': '~', pending: ' ' } as const
  return ['Plan at that point:', ...m.plan.slice(0, 20).map((p) => `- [${mark[p.status]}] ${p.text}`)]
}

// messages after the one this agent's session last saw, before the newest user message
export function missedSince(thread: Thread, agentId: string, skipLast: number): ThreadMessage[] {
  const upto = thread.messages.length - skipLast
  const seen = thread.seen?.[agentId]
  if (!seen) return []
  const at = thread.messages.findIndex((m) => m.id === seen)
  if (at < 0) return []
  return thread.messages.slice(at + 1, upto)
}

// prior turns as a handoff, or null when no other agent took part in them
export function buildHandoff(
  messages: ThreadMessage[],
  toAgentId: string,
  nameOf: (agentId: string) => string,
  maxChars: number
): Handoff | null {
  const usable = messages.filter((m) => m.text.trim() && (m.role === 'user' || m.status !== 'error'))
  const others = [...new Set(usable.filter((m) => m.role === 'agent' && m.agentId && m.agentId !== toAgentId).map((m) => m.agentId!))]
  if (!others.length) return null
  // newest kept first when it gets long
  const blocks: string[] = []
  let used = 0
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]
    const who = m.role === 'user' ? 'User' : m.agentId === toAgentId ? 'You' : nameOf(m.agentId ?? '') || 'Another agent'
    const lines = [`${who}:`, turnText(m).slice(0, MAX_TURN_CHARS)]
    if (m.role === 'agent') {
      const s = stepsLine(m)
      if (s) lines.push(s)
      lines.push(...planLines(m))
    }
    const block = lines.join('\n')
    if (used + block.length > maxChars) break
    used += block.length
    blocks.unshift(block)
  }
  const names = others.map(nameOf).join(', ')
  const head = [
    '## Handoff',
    `Part of this chat was answered by ${names}, not you. Here is what happened, oldest first. Pick up from here as if you had been in the conversation; don't repeat what was already said.`
  ]
  if (blocks.length < usable.length) head.push('(Older turns were left out to save room.)')
  return { text: [...head, '', blocks.join('\n\n')].join('\n'), from: others }
}
