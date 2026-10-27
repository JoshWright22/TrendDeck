import { randomUUID } from 'node:crypto'
import type { ApprovalKind, ApprovalRequest, UserInputRequest } from '@shared/providers'
import type { Sink } from '../agents/parse'
import type { ProviderEvent } from './types'

// bits every adapter needs: the old parser sink as provider events, waiting on the user,
// and a push queue for streamed input

export function sinkFor(emit: (e: ProviderEvent) => void): Sink {
  return {
    text: (text) => text && emit({ type: 'text-delta', text }),
    thinking: (text) => text && emit({ type: 'thinking-delta', text }),
    thinkingTokens: (tokens) => emit({ type: 'thinking-tokens', tokens }),
    step: (step) => emit({ type: 'tool', step }),
    session: (id) => id && emit({ type: 'session', id }),
    contextTokens: (n) => emit({ type: 'usage', contextTokens: n }),
    limits: (windows) => emit({ type: 'limits', windows })
  }
}

// a user answer that comes back later through IPC. everything still open when the turn
// ends resolves with the fallback so the agent isn't left hanging
export class Waiting<T> {
  private open = new Map<string, (v: T) => void>()

  wait(requestId: string, signal: AbortSignal, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (signal.aborted) return resolve(fallback)
      const done = (v: T): void => {
        this.open.delete(requestId)
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const onAbort = (): void => done(fallback)
      signal.addEventListener('abort', onAbort, { once: true })
      this.open.set(requestId, done)
    })
  }

  answer(requestId: string, value: T): boolean {
    const fn = this.open.get(requestId)
    if (!fn) return false
    fn(value)
    return true
  }

  has(requestId: string): boolean {
    return this.open.has(requestId)
  }

  // resolves everything left with the value, e.g. when the session closes
  flush(value: T): void {
    for (const fn of [...this.open.values()]) fn(value)
  }
}

// an async iterable you push into, for agents that take a stream of input
export class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private ended = false

  push(item: T): boolean {
    if (this.ended) return false
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  get closed(): boolean {
    return this.ended
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

const short = (s: string, max = 2000): string => (s.length > max ? `${s.slice(0, max)}...` : s)

export function approvalRequest(
  kind: ApprovalKind,
  title: string,
  detail: string,
  extra: Partial<Pick<ApprovalRequest, 'tool' | 'reason' | 'canRemember' | 'requestId'>> = {}
): ApprovalRequest {
  return {
    requestId: extra.requestId || randomUUID(),
    kind,
    title: short(title, 200),
    detail: short(detail),
    tool: extra.tool,
    reason: extra.reason ? short(extra.reason, 600) : undefined,
    canRemember: extra.canRemember ?? false,
    at: Date.now()
  }
}

export function userInputRequest(questions: UserInputRequest['questions'], requestId = randomUUID()): UserInputRequest {
  return { requestId, questions: questions.slice(0, 8), at: Date.now() }
}

// a turn still waiting on the user this long gets a no, so a closed window can't stall an agent forever
export const ANSWER_TIMEOUT_MS = 15 * 60_000

export function answerSignal(turn: AbortSignal): AbortSignal {
  return AbortSignal.any([turn, AbortSignal.timeout(ANSWER_TIMEOUT_MS)])
}
