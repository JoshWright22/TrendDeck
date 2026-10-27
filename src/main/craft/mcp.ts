import { spawn, type ChildProcess } from 'node:child_process'
import type { McpToolDef } from './rules'

// a small MCP client over stdio for the craft apps' own servers (<id>-cli mcp):
// newline delimited JSON-RPC 2.0, initialize, tools/list, tools/call, progress and cancellation

const PROTOCOL = '2025-06-18'
const MAX_LINE = 64 * 1024 * 1024

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [k: string]: unknown
}

export interface McpCallResult {
  content: McpContent[]
  isError?: boolean
  structuredContent?: unknown
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message)
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void
  timer: NodeJS.Timeout | null
}

export interface McpClientOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  // how long a call may take with no progress before it's given up on
  timeoutMs?: number
}

export class McpClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buf = ''
  private stderr = ''
  private exitHandlers: ((why: string) => void)[] = []
  private closed = false
  serverName = ''
  instructions = ''

  constructor(private readonly opts: McpClientOptions) {}

  get alive(): boolean {
    return !!this.child && !this.closed
  }

  onExit(fn: (why: string) => void): void {
    this.exitHandlers.push(fn)
  }

  async start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.stdin!.on('error', () => {})
    child.on('error', (err) => this.die(`couldn't start: ${err.message}`))
    child.on('exit', (code, signal) => this.die(`stopped (${signal ?? `exit ${code}`})${this.stderr ? `: ${this.lastErr()}` : ''}`))

    const init = (await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'trenddeck', version: '1' }
    }, { timeoutMs: 30_000 })) as { serverInfo?: { name?: string }; instructions?: string }
    this.serverName = init?.serverInfo?.name ?? ''
    this.instructions = typeof init?.instructions === 'string' ? init.instructions : ''
    this.notify('notifications/initialized', {})
  }

  private lastErr(): string {
    return this.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500)
  }

  private die(why: string): void {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(`the app's agent connection ${why}`))
    }
    this.pending.clear()
    for (const fn of this.exitHandlers) fn(why)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    if (this.buf.length > MAX_LINE) {
      this.buf = ''
      this.close()
      return
    }
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    // a request from the server: ping gets an answer, nothing else is offered
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      if (msg.method === 'ping') this.write({ jsonrpc: '2.0', id: msg.id, result: {} })
      else this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })
      return
    }
    if (msg.method === 'notifications/progress') {
      const p = (msg.params ?? {}) as { progressToken?: unknown; progress?: number; total?: number; message?: string }
      const pend = typeof p.progressToken === 'number' ? this.pending.get(p.progressToken) : undefined
      if (pend) {
        this.arm(p.progressToken as number, pend)
        pend.onProgress?.({ progress: Number(p.progress) || 0, total: p.total, message: p.message })
      }
      return
    }
    if (typeof msg.method === 'string') return
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const pend = this.pending.get(id)
    if (!pend) return
    this.pending.delete(id)
    if (pend.timer) clearTimeout(pend.timer)
    const err = msg.error as { code?: number; message?: string } | undefined
    if (err) pend.reject(new McpError(err.message ?? 'error', err.code ?? -32603))
    else pend.resolve(msg.result)
  }

  private write(msg: unknown): void {
    if (!this.child?.stdin || this.closed) return
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private timeoutFor = new Map<number, number>()

  // restarts the no-progress timer
  private arm(id: number, p: Pending): void {
    const ms = this.timeoutFor.get(id) ?? 0
    if (!ms) return
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => this.cancel(id, 'timed out', true), ms)
  }

  request(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal; onProgress?: Pending['onProgress'] } = {}
  ): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error("the app's agent connection isn't running"))
    const id = this.nextId++
    const withProgress = opts.onProgress ? { ...params, _meta: { progressToken: id } } : params
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, onProgress: opts.onProgress, timer: null }
      this.pending.set(id, p)
      this.timeoutFor.set(id, opts.timeoutMs ?? this.opts.timeoutMs ?? 120_000)
      this.arm(id, p)
      if (opts.signal) {
        if (opts.signal.aborted) return this.cancel(id, 'cancelled')
        opts.signal.addEventListener('abort', () => this.cancel(id, String(opts.signal?.reason ?? 'cancelled')), { once: true })
      }
      this.write({ jsonrpc: '2.0', id, method, params: withProgress })
    }).finally(() => this.timeoutFor.delete(id))
  }

  // MCP cancellation: the server stops and sends no answer, so the call ends here
  private cancel(id: number, reason: string, timedOut = false): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    this.notify('notifications/cancelled', { requestId: id, reason })
    p.reject(new Error(timedOut ? 'the app took too long to answer, the call was stopped' : `stopped: ${reason}`))
  }

  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpToolDef[]; nextCursor?: string }
      for (const t of r?.tools ?? []) if (t && typeof t.name === 'string') out.push(t)
      if (!r?.nextCursor) break
      cursor = r.nextCursor
    }
    return out
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number; onProgress?: Pending['onProgress'] } = {}
  ): Promise<McpCallResult> {
    const r = (await this.request('tools/call', { name, arguments: args }, opts)) as McpCallResult
    return { content: Array.isArray(r?.content) ? r.content : [], isError: r?.isError === true, structuredContent: r?.structuredContent }
  }

  close(): void {
    if (!this.child) return
    const child = this.child
    try {
      child.stdin?.end()
    } catch {
      // already gone
    }
    // stdin closing ends a stdio server, a stuck one is killed
    const t = setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 3000)
    child.once('exit', () => clearTimeout(t))
    this.die('closed')
  }
}
