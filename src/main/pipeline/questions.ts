import { randomUUID } from 'node:crypto'
import type { PipelineAnswer, PipelineQuestion, QuestionClosed, QuestionItem } from '@shared/pipeline'
import { broadcast, hasWindow, Waiters } from '../gateway/wait'

export type QuestionOutcome =
  | { kind: 'answered'; picks: string[][] }
  | { kind: 'dismissed' | 'timeout' | 'cancelled' }

const waiters = new Waiters<PipelineQuestion, QuestionOutcome>((id, reason) => {
  broadcast('pipeline:question-closed', { id, reason: reason as QuestionClosed['reason'] } satisfies QuestionClosed)
})

export async function askUser(
  input: Omit<PipelineQuestion, 'id' | 'createdAt' | 'expiresAt' | 'allowOther'>,
  timeoutMs: number
): Promise<QuestionOutcome> {
  if (!hasWindow()) return { kind: 'cancelled' }
  const now = Date.now()
  const q: PipelineQuestion = { ...input, id: randomUUID(), allowOther: true, createdAt: now, expiresAt: now + timeoutMs }
  const wait = waiters.wait(q, q.turnId, timeoutMs, { kind: 'timeout' })
  broadcast('pipeline:question', q)
  return wait
}

export function answerQuestion(raw: unknown): boolean {
  const a = (raw ?? {}) as Partial<PipelineAnswer>
  if (typeof a.id !== 'string') return false
  const q = waiters.get(a.id)
  if (!q) return false
  if (a.dismissed === true) return waiters.finish(a.id, { kind: 'dismissed' }, 'dismissed')
  const picks = q.questions.map((_, i) => {
    const list = Array.isArray(a.picks?.[i]) ? (a.picks[i] as unknown[]) : []
    return list.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim().slice(0, 2000)).slice(0, 20)
  })
  return waiters.finish(a.id, { kind: 'answered', picks }, 'answered')
}

export function pendingQuestions(): PipelineQuestion[] {
  return waiters.list()
}

export function dropTurnQuestions(turnId: string): void {
  for (const id of waiters.forTurn(turnId)) waiters.finish(id, { kind: 'cancelled' }, 'cancelled')
}

// same text the chat's question card sends back, see Questions.tsx answerText
export function answerText(qs: QuestionItem[], picks: string[][]): string {
  return qs.map((q, i) => `Q: ${q.question}\nA: ${picks[i]?.length ? picks[i].join(', ') : '(no answer)'}`).join('\n\n')
}
