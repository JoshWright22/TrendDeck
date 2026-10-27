import { BrowserWindow } from 'electron'

// things a tool call waits on the user for: approvals and ask_user questions.
// each one ends exactly once, by an answer, a timeout or its turn ending
interface Entry<Req, Ans> {
  req: Req
  turnId: string
  done: (a: Ans) => void
  timer: NodeJS.Timeout
}

export class Waiters<Req extends { id: string }, Ans> {
  private open = new Map<string, Entry<Req, Ans>>()

  constructor(
    private readonly onClose: (id: string, reason: string) => void
  ) {}

  wait(req: Req, turnId: string, ms: number, onTimeout: Ans): Promise<Ans> {
    return new Promise<Ans>((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, onTimeout, 'timeout'), ms)
      this.open.set(req.id, { req, turnId, done: resolve, timer })
    })
  }

  finish(id: string, answer: Ans, reason: string): boolean {
    const e = this.open.get(id)
    if (!e) return false
    clearTimeout(e.timer)
    this.open.delete(id)
    e.done(answer)
    this.onClose(id, reason)
    return true
  }

  get(id: string): Req | null {
    return this.open.get(id)?.req ?? null
  }

  list(): Req[] {
    return [...this.open.values()].map((e) => e.req)
  }

  forTurn(turnId: string): string[] {
    return [...this.open.entries()].filter(([, e]) => e.turnId === turnId).map(([id]) => id)
  }
}

// to the app window only. site tabs are webviews and never get these
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function hasWindow(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())
}
