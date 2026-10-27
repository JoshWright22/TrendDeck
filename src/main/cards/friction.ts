import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

// moments where the user pushed back on what the agent did in an editor: undid a reply's edits,
// kept them, dropped an alternative. one json line each in <user data>/friction/<brand>.jsonl,
// for the brand style memory to learn from later. never throws, a lost line is fine

export interface FrictionEvent {
  brandId: string
  threadId: string | null
  projectId?: string | null
  appId?: string | null
  // undo-turn, keep-turn, keep-alternative, undo-alternative, comment
  kind: string
  // how many edits it was about, when that's known
  edits?: number
  detail?: string
  at?: number
}

const MAX_LINE = 4000
let queue: Promise<unknown> = Promise.resolve()

export const frictionDir = (): string => join(app.getPath('userData'), 'friction')

export function recordFriction(event: FrictionEvent): Promise<void> {
  const run = async (): Promise<void> => {
    if (!event || typeof event.brandId !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(event.brandId)) return
    const line = JSON.stringify({ ...event, detail: event.detail?.slice(0, 1000), at: event.at ?? Date.now() }).slice(0, MAX_LINE)
    await fs.mkdir(frictionDir(), { recursive: true })
    await fs.appendFile(join(frictionDir(), `${event.brandId}.jsonl`), `${line}\n`, 'utf8')
  }
  const next = queue.then(run, run).catch((err) => console.error('cards: a friction line was lost', err))
  queue = next
  return next
}
