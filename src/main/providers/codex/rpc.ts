import type { ChildProcess } from 'node:child_process'

// codex app-server speaks json-rpc over stdio, one json object per line, without the
// "jsonrpc" field. requests go both ways: we ask it things, it asks us for approvals

type Id = string | number

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout | null
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void

const DEFAULT_TIMEOUT_MS = 60_000

export class StdioRpc {
  private nextId = 1
  private pending = new Map<Id, Pending>()
  private buf = ''
  private closedWith: Error | null = null
  private onNote: NotificationHandler = () => {}
  private onRequest: RequestHandler = async (method) => {
    throw new RpcError(`no handler for ${method}`, -32601)
  }
  private stderr = ''

  constructor(private child: ChildProcess) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.read(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.stdin?.on('error', () => {})
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      const why = this.stderrTail()
      this.fail(new Error(why || `codex app-server quit with code ${code}`))
    })
  }

  stderrTail(): string {
    return this.stderr.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim().split('\n').slice(-6).join('\n')
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  notifications(fn: NotificationHandler): void {
    this.onNote = fn
  }

  requests(fn: RequestHandler): void {
    this.onRequest = fn
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`codex didn't answer ${method} in time`))
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  private write(msg: unknown): void {
    if (this.closedWith || !this.child.stdin?.writable) return
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private read(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (line) this.handle(line)
    }
  }

  private handle(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = msg.id as Id | undefined
    const method = typeof msg.method === 'string' ? msg.method : null
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
    if (method && id !== undefined && id !== null) {
      // a request from codex, e.g. an approval
      this.onRequest(method, params).then(
        (result) => this.write({ id, result: result ?? {} }),
        (err: unknown) => {
          const code = err instanceof RpcError ? err.code : -32603
          this.write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } })
        }
      )
      return
    }
    if (method) {
      try {
        this.onNote(method, params)
      } catch {
        // a bad notification shouldn't take the session down
      }
      return
    }
    if (id === undefined || id === null) return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    const error = msg.error as { code?: number; message?: string; data?: unknown } | undefined
    if (error) p.reject(new RpcError(error.message ?? 'codex returned an error', error.code ?? -32603, error.data))
    else p.resolve(msg.result)
  }

  private fail(err: Error): void {
    if (this.closedWith) return
    this.closedWith = err
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
