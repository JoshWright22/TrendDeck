import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promises as fs, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { McpClient, McpError, type McpCallResult } from '../craft/mcp'
import type { McpToolDef } from '../craft/rules'

// connections to your own MCP servers. stdio reuses the craft apps' client, started the windows
// way (npx is a .cmd and node won't run those without a shell). http speaks streamable http and
// falls back to the old sse transport

const PROTOCOL = '2025-06-18'
export const INIT_TIMEOUT_MS = 30_000
export const CALL_TIMEOUT_MS = 120_000
// one answer or event bigger than this ends the connection
const MAX_BODY = 64 * 1024 * 1024

export interface Conn {
  readonly alive: boolean
  start(): Promise<void>
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>
  close(): void
  // quitting: nothing gets to wait, children are killed now
  kill(): void
  onExit(fn: (why: string) => void): void
}

// ---- stdio ----

const isWin = process.platform === 'win32'

function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  if (!isWin) return env[name]
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase() && env[x] !== undefined)
  return k ? env[k] : undefined
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// the command as a full path, found on PATH with PATHEXT on windows. null when it's nowhere
export function resolveCommand(command: string, env: Record<string, string | undefined>): string | null {
  const exts = isWin
    ? (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : ['']
  const tryAt = (base: string): string | null => {
    if (isWin) {
      const ext = extname(base).toLowerCase()
      if (ext && exts.includes(ext) && isFile(base)) return base
      for (const e of exts) if (isFile(base + e)) return base + e
      return null
    }
    return isFile(base) ? base : null
  }
  if (isAbsolute(command) || /[\\/]/.test(command)) return tryAt(command)
  for (const d of (envGet(env, 'PATH') ?? '').split(delimiter)) {
    const dir = d.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    const hit = tryAt(join(dir, command))
    if (hit) return hit
  }
  return null
}

// one argument for cmd.exe and the program behind the batch file. always quoted so & | < > ( ) ^
// stay plain text, a trailing backslash doubled so it doesn't eat the closing quote. a quote
// inside can't be made safe for cmd, so it's refused
export function cmdQuote(arg: string): string {
  if (arg.includes('"')) throw new Error("an argument has a quote in it, that can't be passed safely to a .cmd or .bat file")
  if (/[\0\r\n]/.test(arg)) throw new Error("an argument has a line break in it, that can't be passed to a .cmd or .bat file")
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

const LAUNCH_VAR = 'TRENDDECK_MCP_LAUNCH'

// how to start a resolved command. .cmd and .bat go through cmd.exe: node quotes every argument
// its own way, which cmd reads wrong, so the real command line rides in an env var that cmd
// expands once (what comes out of it isn't expanded again). /d skips autorun, /v:off keeps ! plain
export function launchFor(file: string, args: string[]): { command: string; args: string[]; env: Record<string, string> } {
  if (isWin && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(cmdQuote).join(' ')
    const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    return { command: cmd, args: ['/d', '/v:off', '/s', '/c', `%${LAUNCH_VAR}%`], env: { [LAUNCH_VAR]: line } }
  }
  return { command: file, args, env: {} }
}

// what a child gets: the app's env with your vars on top. other apps' tokens and electron's
// node switch never go through. undefined drops a key from what McpClient passes on
function childEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ELECTRON_RUN_AS_NODE: undefined }
  const lower = new Map(Object.keys(extra).map((k) => [k.toLowerCase(), k]))
  for (const k of Object.keys(process.env)) {
    if (/_CONTROL_TOKEN$|^TRENDDECK_MCP_|^ELECTRON_RUN_AS_NODE$/i.test(k)) out[k] = undefined
    // your PATH replaces the app's Path, windows would get both otherwise
    const mine = lower.get(k.toLowerCase())
    if (isWin && mine && mine !== k) out[k] = undefined
  }
  return { ...out, ...extra }
}

function killTree(child: ChildProcess | null, now: boolean): void {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (isWin) {
    // cmd.exe and npx start more processes under it, /T ends all of them
    const args = ['/pid', String(child.pid), '/T', '/F']
    if (now) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 3000 })
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  } else child.kill()
}

// the craft client says "the app", here it's your server
function serverWords(msg: string): string {
  return msg
    .replace(/the app's agent connection/g, 'the server')
    .replace(/the app took too long to answer/g, 'the server took too long to answer')
}

function plainError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  return new Error(serverWords(msg))
}

export interface StdioOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export class StdioConn implements Conn {
  private client: McpClient | null = null
  private handlers: ((why: string) => void)[] = []

  constructor(private readonly opts: StdioOptions) {}

  get alive(): boolean {
    return !!this.client?.alive
  }

  onExit(fn: (why: string) => void): void {
    this.handlers.push(fn)
  }

  // McpClient keeps its child private, the pid is needed to end the whole tree
  private child(): ChildProcess | null {
    return (this.client as unknown as { child?: ChildProcess | null } | null)?.child ?? null
  }

  async start(): Promise<void> {
    const env = childEnv(this.opts.env)
    const merged = { ...process.env, ...env }
    const file = resolveCommand(this.opts.command, merged)
    if (!file) throw new Error(`couldn't find ${this.opts.command}. Is it installed and on your PATH?`)
    if (this.opts.cwd) {
      const st = await fs.stat(this.opts.cwd).catch(() => null)
      if (!st?.isDirectory()) throw new Error(`the folder to run in isn't there: ${this.opts.cwd}`)
    }
    const launch = launchFor(file, this.opts.args)
    const client = new McpClient({
      command: launch.command,
      args: launch.args,
      env: { ...env, ...launch.env } as Record<string, string>,
      cwd: this.opts.cwd || undefined,
      timeoutMs: CALL_TIMEOUT_MS
    })
    this.client = client
    client.onExit((why) => {
      for (const fn of this.handlers) fn(serverWords(why))
    })
    try {
      await client.start()
    } catch (err) {
      this.close()
      throw plainError(err)
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.client) throw new Error("the server isn't running")
    try {
      return await this.client.listTools()
    } catch (err) {
      throw plainError(err)
    }
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult> {
    if (!this.client) throw new Error("the server isn't running")
    try {
      return await this.client.callTool(name, args, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS })
    } catch (err) {
      if (err instanceof McpError) throw new Error(serverWords(err.message))
      throw plainError(err)
    }
  }

  close(): void {
    const child = this.child()
    this.client?.close()
    // a server that doesn't stop when its input closes is ended, with everything it started
    if (child && child.exitCode === null) {
      const t = setTimeout(() => killTree(child, false), 2500)
      child.once('exit', () => clearTimeout(t))
    }
  }

  kill(): void {
    const child = this.child()
    this.client?.close()
    killTree(child, true)
  }
}

// ---- http ----

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

// the session the server gave us is gone, start a new one
class SessionGone extends Error {}

function netError(err: unknown, url: string): Error {
  if (err instanceof HttpError || err instanceof SessionGone) return err
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.message === 'fetch failed' || e?.name === 'TypeError') {
    const why = e.cause?.code || e.cause?.message || ''
    return new Error(`couldn't reach ${new URL(url).host}${why ? ` (${why})` : ''}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

async function httpError(res: Response): Promise<HttpError> {
  let body = ''
  try {
    body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch {
    // nothing to show
  }
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') ?? ''
    return new HttpError(`the server sent TrendDeck to another address${to ? ` (${to.slice(0, 200)})` : ''}, use that one instead`, res.status)
  }
  const what = res.status === 401 || res.status === 403 ? `the server said no (${res.status}), check its key or login headers` : `the server answered ${res.status}`
  return new HttpError(body ? `${what}: ${body}` : what, res.status)
}

interface SseEvent {
  event: string
  data: string
}

// server sent events, one at a time
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      for (;;) {
        const i = buf.search(/\r\n|\r|\n/)
        if (i < 0) break
        // a \r at the very end may be the first half of \r\n
        if (buf[i] === '\r' && i === buf.length - 1) break
        const nl = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1
        const line = buf.slice(0, i)
        buf = buf.slice(i + nl)
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') }
          event = ''
          data = []
          size = 0
          continue
        }
        if (line.startsWith(':')) continue
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        let val = c < 0 ? '' : line.slice(c + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'event') event = val
        else if (field === 'data') {
          size += val.length
          data.push(val)
        }
      }
      if (buf.length + size > MAX_BODY) throw new Error('the server sent too much at once')
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function readBody(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BODY) throw new Error('the server sent too much at once')
  const text = await res.text()
  if (text.length > MAX_BODY) throw new Error('the server sent too much at once')
  return text
}

type RpcMessage = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

function parseMessages(text: string): RpcMessage[] {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(v) ? v : [v]
  return list.filter((m): m is RpcMessage => !!m && typeof m === 'object')
}

// a deadline and the caller's cancel in one signal. which one fired is told apart after
function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ac = new AbortController()
  let late = false
  const t = setTimeout(() => {
    late = true
    ac.abort(new Error('timeout'))
  }, ms)
  const onAbort = (): void => ac.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) ac.abort(outer.reason)
    else outer.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ac.signal,
    timedOut: () => late,
    done: () => {
      clearTimeout(t)
      outer?.removeEventListener('abort', onAbort)
    }
  }
}

function answerOf(m: RpcMessage, id: number): { hit: boolean; value?: unknown; error?: Error } {
  if (m.method !== undefined || m.id === undefined || m.id === null || Number(m.id) !== id) return { hit: false }
  if (m.error) return { hit: true, error: new McpError(String(m.error.message ?? 'error'), Number(m.error.code ?? -32603)) }
  return { hit: true, value: m.result }
}

export interface HttpOptions {
  url: string
  headers: Record<string, string>
}

export class HttpConn implements Conn {
  private nextId = 1
  private session = ''
  private protocol = PROTOCOL
  private ready = false
  private closed = false
  private legacy: LegacySse | null = null
  private handlers: ((why: string) => void)[] = []

  constructor(private readonly opts: HttpOptions) {}

  get alive(): boolean {
    return this.ready && !this.closed
  }

  onExit(fn: (why: string) => void): void {
    this.handlers.push(fn)
  }

  private die(why: string): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    for (const fn of this.handlers) fn(why)
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.opts.headers }
    if (this.session) h['mcp-session-id'] = this.session
    if (this.ready) h['mcp-protocol-version'] = this.protocol
    return h
  }

  private async post(msg: RpcMessage, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.opts.url, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(msg),
        signal,
        // a redirect could carry your headers to another site
        redirect: 'manual'
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw netError(err, this.opts.url)
    }
  }

  // a server's own request mid stream: ping is answered, nothing else is offered
  private answerServer(m: RpcMessage): void {
    if (typeof m.method !== 'string' || m.id === undefined || m.id === null) return
    const reply = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } }
    if (this.legacy) void this.legacy.send(reply).catch(() => {})
    else void this.post(reply as RpcMessage, AbortSignal.timeout(10_000)).then((r) => r.body?.cancel()).catch(() => {})
  }

  private async postRequest(msg: RpcMessage & { id: number }, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
    const d = deadline(timeoutMs, outer)
    try {
      const res = await this.post(msg, d.signal)
      if (res.status === 404 && this.session && msg.method !== 'initialize') {
        void res.body?.cancel()
        throw new SessionGone('the server forgot the session')
      }
      if (!res.ok) throw await httpError(res)
      if (msg.method === 'initialize') {
        const sid = res.headers.get('mcp-session-id') ?? ''
        if (sid && /^[\x21-\x7e]{1,1000}$/.test(sid)) this.session = sid
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      if (type.includes('text/event-stream') && res.body) {
        for await (const ev of sseEvents(res.body)) {
          if (ev.event !== 'message') continue
          for (const m of parseMessages(ev.data)) {
            const a = answerOf(m, msg.id)
            if (a.hit) {
              if (a.error) throw a.error
              return a.value
            }
            this.answerServer(m)
          }
        }
        throw new Error('the server ended the answer without a result')
      }
      const text = await readBody(res)
      for (const m of parseMessages(text)) {
        const a = answerOf(m, msg.id)
        if (a.hit) {
          if (a.error) throw a.error
          return a.value
        }
      }
      throw new Error("the server's answer wasn't JSON-RPC")
    } catch (err) {
      if (d.signal.aborted) {
        if (this.ready) void this.notify('notifications/cancelled', { requestId: msg.id, reason: d.timedOut() ? 'timed out' : 'cancelled' })
        throw new Error(d.timedOut() ? 'the server took too long to answer, the call was stopped' : `stopped: ${String(outer?.reason ?? 'cancelled')}`)
      }
      throw err
    } finally {
      d.done()
    }
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('the connection to the server is closed')
    if (this.legacy) return this.legacy.request({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs, signal)
    try {
      return await this.postRequest({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs, signal)
    } catch (err) {
      if (!(err instanceof SessionGone)) throw err
      // a server restart drops sessions, one new handshake and the call again
      this.session = ''
      this.ready = false
      await this.handshake()
      return this.postRequest({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs, signal)
    }
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const msg = { jsonrpc: '2.0', method, params }
    if (this.legacy) return this.legacy.send(msg)
    const res = await this.post(msg, AbortSignal.timeout(10_000))
    void res.body?.cancel()
  }

  private initParams(): Record<string, unknown> {
    return { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'trenddeck', version: '1' } }
  }

  private afterInit(init: unknown): void {
    const v = (init as { protocolVersion?: unknown } | null)?.protocolVersion
    if (typeof v === 'string' && /^[\w.-]{1,40}$/.test(v)) this.protocol = v
    this.ready = true
  }

  private async handshake(): Promise<void> {
    const init = await this.postRequest({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: this.initParams() }, INIT_TIMEOUT_MS)
    this.afterInit(init)
    await this.notify('notifications/initialized', {}).catch(() => {})
  }

  async start(): Promise<void> {
    try {
      await this.handshake()
      return
    } catch (err) {
      // servers from before 2025 only speak sse: a GET for the stream, then POSTs to the address it names
      if (!(err instanceof HttpError) || ![400, 404, 405].includes(err.status)) throw err
      const legacy = new LegacySse(this.opts.url, this.opts.headers, (why) => this.die(why), (m) => this.answerServer(m))
      try {
        await legacy.open()
        this.legacy = legacy
        const init = await legacy.request({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: this.initParams() }, INIT_TIMEOUT_MS)
        this.afterInit(init)
        await legacy.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {})
      } catch {
        legacy.close()
        this.legacy = null
        throw err
      }
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, CALL_TIMEOUT_MS)) as { tools?: McpToolDef[]; nextCursor?: string }
      for (const t of r?.tools ?? []) if (t && typeof t.name === 'string') out.push(t)
      if (typeof r?.nextCursor !== 'string' || !r.nextCursor) break
      cursor = r.nextCursor
    }
    return out
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult> {
    const r = (await this.request('tools/call', { name, arguments: args }, opts.timeoutMs ?? CALL_TIMEOUT_MS, opts.signal)) as McpCallResult
    return { content: Array.isArray(r?.content) ? r.content : [], isError: r?.isError === true, structuredContent: r?.structuredContent }
  }

  close(): void {
    if (this.closed) return
    // tell the server the session is over, it doesn't have to listen
    if (this.session && !this.legacy) {
      void fetch(this.opts.url, {
        method: 'DELETE',
        headers: this.baseHeaders(),
        signal: AbortSignal.timeout(3000),
        redirect: 'manual'
      })
        .then((r) => r.body?.cancel())
        .catch(() => {})
    }
    this.legacy?.close()
    this.die('closed')
  }

  kill(): void {
    this.close()
  }
}

// the old http+sse transport: answers come back on the GET stream, not the POST
class LegacySse {
  private ac = new AbortController()
  private endpoint: string | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private dead = false

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onDie: (why: string) => void,
    private readonly onRequest: (m: RpcMessage) => void
  ) {}

  async open(): Promise<void> {
    const t = setTimeout(() => this.ac.abort(new Error('timeout')), INIT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(this.url, { headers: { ...this.headers, accept: 'text/event-stream' }, signal: this.ac.signal, redirect: 'manual' })
    } catch (err) {
      clearTimeout(t)
      throw netError(err, this.url)
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
      clearTimeout(t)
      throw res.ok ? new Error("the server didn't open an event stream") : await httpError(res)
    }
    const body = res.body
    await new Promise<void>((resolve, reject) => {
      void (async () => {
        try {
          for await (const ev of sseEvents(body)) {
            if (ev.event === 'endpoint' && !this.endpoint) {
              const to = new URL(ev.data.trim(), this.url)
              // your headers only ever go to the server's own origin
              if (to.origin !== new URL(this.url).origin) throw new Error('the server named an address on another site')
              this.endpoint = to.href
              clearTimeout(t)
              resolve()
            } else if (ev.event === 'message') {
              for (const m of parseMessages(ev.data)) this.onMessage(m)
            }
          }
          throw new Error('the server closed the event stream')
        } catch (err) {
          clearTimeout(t)
          const why = this.ac.signal.aborted && !this.dead ? 'the server took too long to answer' : err instanceof Error ? err.message : String(err)
          reject(new Error(why))
          this.die(why)
        }
      })()
    })
  }

  private onMessage(m: RpcMessage): void {
    if (typeof m.method === 'string') {
      this.onRequest(m)
      return
    }
    const id = Number(m.id)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (m.error) p.reject(new McpError(String(m.error.message ?? 'error'), Number(m.error.code ?? -32603)))
    else p.resolve(m.result)
  }

  async send(msg: unknown): Promise<void> {
    if (!this.endpoint || this.dead) throw new Error('the connection to the server is closed')
    let res: Response
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(30_000),
        redirect: 'manual'
      })
    } catch (err) {
      throw netError(err, this.endpoint)
    }
    if (!res.ok) throw await httpError(res)
    void res.body?.cancel()
  }

  request(msg: RpcMessage & { id: number }, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
    const d = deadline(timeoutMs, outer)
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject })
      d.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(msg.id)) return
          void this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id, reason: d.timedOut() ? 'timed out' : 'cancelled' } }).catch(() => {})
          reject(new Error(d.timedOut() ? 'the server took too long to answer, the call was stopped' : `stopped: ${String(outer?.reason ?? 'cancelled')}`))
        },
        { once: true }
      )
      this.send(msg).catch((err: Error) => {
        if (this.pending.delete(msg.id)) reject(err)
      })
    }).finally(() => d.done())
  }

  private die(why: string): void {
    if (this.dead) return
    this.dead = true
    for (const [, p] of this.pending) p.reject(new Error(`the server ${why.replace(/^the server /, '')}`))
    this.pending.clear()
    this.onDie(why)
  }

  close(): void {
    this.dead = true
    this.ac.abort(new Error('closed'))
    for (const [, p] of this.pending) p.reject(new Error('the connection to the server is closed'))
    this.pending.clear()
  }
}
