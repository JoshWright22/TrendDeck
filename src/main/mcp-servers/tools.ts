import { promises as fs } from 'node:fs'
import { dirname, extname, isAbsolute } from 'node:path'
import type { McpServerStatus, McpTestResult } from '@shared/mcp-servers'
import type { McpContent } from '../craft/mcp'
import { projectsRoot } from '../craft/paths'
import { gatewaySchema, isInside } from '../craft/rules'
import { redactText } from '../gateway/redact'
import { ContentResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import type { JsonSchema } from '../gateway/validate'
import { broadcast } from '../gateway/wait'
import { onTurnClosed } from '../mcp/turns'
import { CALL_TIMEOUT_MS, HttpConn, StdioConn, type Conn } from './client'
import { cleanToolDefs, toolEntries, type StoredServer, type ToolEntry } from './config'
import { cachedTools, openedPairs, serverNow, serverSecrets, serversNow, storeTools } from './store'

// the live connections to your servers and their tools for the gateway. a server starts the
// first time it's needed (a call, a save, Test connection) and stops after a while unused.
// tools/list comes from the cached list, so it works with nothing running

interface Live {
  conn: Conn | null
  connecting: Promise<Conn> | null
  status: McpServerStatus
  error: string
  // bumped when the server is changed or stopped, a connect from before that is thrown away
  gen: number
  busy: number
  idle: NodeJS.Timeout | null
}

const live = new Map<string, Live>()
// a server nobody called for this long is stopped, it starts again on the next call
const IDLE_MS = 15 * 60_000
// what one call can hand back as text
const MAX_TEXT = 200_000

function slot(id: string): Live {
  let l = live.get(id)
  if (!l) live.set(id, (l = { conn: null, connecting: null, status: 'off', error: '', gen: 0, busy: 0, idle: null }))
  return l
}

export function changed(): void {
  broadcast('mcp-servers:changed', null)
}

export function liveOf(id: string): { status: McpServerStatus; error: string } {
  const l = live.get(id)
  return l ? { status: l.status, error: l.error } : { status: 'off', error: '' }
}

// one short line, the server's own secrets and anything key shaped scrubbed out
export function cleanError(id: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = redactText(msg.replace(/\s+/g, ' ').trim(), serverSecrets(id))
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

function touch(id: string, l: Live): void {
  if (l.idle) clearTimeout(l.idle)
  l.idle = setTimeout(() => {
    l.idle = null
    if (l.busy > 0) touch(id, l)
    else disconnect(id)
  }, IDLE_MS)
}

// the filesystem preset points at the brand's projects folder, which may not be made yet
async function makeFolders(s: StoredServer, env: Record<string, string>): Promise<void> {
  let root: string
  try {
    root = projectsRoot()
  } catch {
    return
  }
  for (const v of [...s.args, ...Object.values(env)]) {
    if (!isAbsolute(v) || !isInside(root, v)) continue
    await fs.mkdir(extname(v) ? dirname(v) : v, { recursive: true }).catch(() => {})
  }
}

function makeConn(s: StoredServer): { conn: Conn; ready: Promise<void> } {
  const { env, headers } = openedPairs(s.id)
  if (s.kind === 'http') return { conn: new HttpConn({ url: s.url, headers }), ready: Promise.resolve() }
  return { conn: new StdioConn({ command: s.command, args: s.args, env, cwd: s.cwd }), ready: makeFolders(s, env) }
}

// the running connection, started when there's none or the last one died
export function connect(s: StoredServer): Promise<Conn> {
  const l = slot(s.id)
  if (l.conn?.alive) {
    touch(s.id, l)
    return Promise.resolve(l.conn)
  }
  if (l.connecting) return l.connecting
  l.conn = null
  const gen = l.gen
  l.status = 'connecting'
  l.error = ''
  changed()
  const p = (async (): Promise<Conn> => {
    const { conn, ready } = makeConn(s)
    conn.onExit((why) => {
      if (l.conn !== conn) return
      l.conn = null
      if (l.idle) clearTimeout(l.idle)
      l.idle = null
      l.status = why === 'closed' ? 'off' : 'error'
      l.error = why === 'closed' ? '' : cleanError(s.id, why)
      changed()
    })
    try {
      await ready
      await conn.start()
      const defs = cleanToolDefs(await conn.listTools())
      if (l.gen !== gen) throw new Error('the server was changed while it was starting')
      if (!conn.alive) throw new Error('the server stopped right after it started')
      await storeTools(s.id, defs)
      l.conn = conn
      l.status = 'ready'
      l.error = ''
      touch(s.id, l)
      return conn
    } catch (err) {
      conn.close()
      const msg = cleanError(s.id, err)
      if (l.gen === gen) {
        l.status = 'error'
        l.error = msg
      }
      throw new Error(msg)
    } finally {
      if (l.gen === gen) l.connecting = null
      changed()
    }
  })()
  l.connecting = p
  return p
}

export function disconnect(id: string): void {
  const l = live.get(id)
  if (!l) return
  l.gen++
  l.connecting = null
  if (l.idle) clearTimeout(l.idle)
  l.idle = null
  const c = l.conn
  l.conn = null
  const was = l.status
  l.status = 'off'
  l.error = ''
  c?.close()
  if (was !== 'off') changed()
}

export function forgetLive(id: string): void {
  disconnect(id)
  live.delete(id)
}

// quitting: every child ends now, with whatever it started
export function closeAll(): void {
  for (const l of live.values()) {
    l.gen++
    if (l.idle) clearTimeout(l.idle)
    const c = l.conn
    l.conn = null
    try {
      c?.kill()
    } catch {
      // already gone
    }
  }
  live.clear()
}

// Test connection: a fresh start and a new tool list
export async function testServer(id: string): Promise<McpTestResult> {
  const s = serverNow(id)
  if (!s) return { ok: false, error: "That server isn't saved anymore.", tools: 0 }
  disconnect(id)
  try {
    await connect(s)
    return { ok: true, error: '', tools: cachedTools(id)?.defs.length ?? 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), tools: 0 }
  }
}

// ---- calls ----

// calls still running when their turn ends are cancelled
const turnCalls = new Map<string, Set<AbortController>>()

function forTurn(turnId: string): AbortController {
  const ac = new AbortController()
  let set = turnCalls.get(turnId)
  if (!set) turnCalls.set(turnId, (set = new Set()))
  set.add(ac)
  return ac
}

export function setupTurnHook(): void {
  onTurnClosed((turn) => {
    for (const ac of turnCalls.get(turn.id) ?? []) ac.abort('the chat turn ended')
    turnCalls.delete(turn.id)
  })
}

// the server's mcp content as gateway content. audio, links and blobs are named, not passed on
function content(items: McpContent[], structured: unknown): ContentResult['content'] {
  const out: ContentResult['content'] = []
  let room = MAX_TEXT
  const text = (t: string): void => {
    if (room <= 0) return
    const cut = t.length > room ? `${t.slice(0, room)}\n(cut short, the answer was too long)` : t
    room -= t.length
    out.push({ type: 'text', text: cut })
  }
  for (const c of items) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') text(c.text)
    else if (c.type === 'image' && typeof c.data === 'string' && /^image\/[\w.+-]+$/.test(String(c.mimeType ?? ''))) {
      out.push({ type: 'image', data: c.data, mimeType: String(c.mimeType) })
    } else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const r = c.resource as { uri?: unknown; text?: unknown; mimeType?: unknown }
      text(typeof r.text === 'string' ? r.text : `(a file, ${String(r.uri ?? '')} ${String(r.mimeType ?? '')}, left out)`)
    } else if (c.type === 'resource_link') {
      text(`link: ${String((c as { uri?: unknown }).uri ?? '')}${c.name ? ` (${String(c.name)})` : ''}`)
    } else text(`(${String(c.type).slice(0, 40)} content left out)`)
  }
  if (!out.length && structured !== undefined) {
    try {
      text(JSON.stringify(structured, null, 2))
    } catch {
      // not json
    }
  }
  return out.length ? out : [{ type: 'text', text: 'done' }]
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

function serverTool(s: StoredServer, t: ToolEntry): GatewayTool {
  const toolTitle = t.def.title ?? t.def.annotations?.title ?? t.def.name
  const about = clip((t.def.description ?? '').trim() || toolTitle, 2000)
  return {
    name: t.name,
    title: clip(`${s.label}: ${toolTitle}`, 120),
    description: `${about}\n\nFrom ${s.label}, an MCP server the user added to TrendDeck themselves. TrendDeck passes the call on as is.`,
    inputSchema: gatewaySchema(t.def.inputSchema) as unknown as JsonSchema,
    risk: t.risk,
    alwaysAsk: t.alwaysAsk,
    annotations: {
      destructiveHint: t.def.annotations?.destructiveHint === true,
      idempotentHint: t.def.annotations?.idempotentHint === true,
      openWorldHint: t.def.annotations?.openWorldHint !== false
    },
    // read when the call comes, so trusting it in Settings counts right away
    mustAsk: async () => {
      const cur = serverNow(s.id)
      return cur?.trusted ? null : `TrendDeck asks before every call to ${cur?.label ?? s.label} until you trust it in Settings`
    },
    summarize: () => `${s.label}: ${toolTitle}`,
    run: async (turn, args) => {
      const cur = serverNow(s.id)
      if (!cur || !cur.brands[turn.brandId]) throw new ToolError(`${s.label} is turned off for this brand`)
      let conn: Conn
      try {
        conn = await connect(cur)
      } catch (err) {
        throw new ToolError(`${cur.label} didn't start: ${err instanceof Error ? err.message : String(err)}`)
      }
      const l = slot(cur.id)
      const ac = forTurn(turn.id)
      l.busy++
      try {
        const r = await conn.callTool(t.def.name, args, { signal: ac.signal, timeoutMs: CALL_TIMEOUT_MS })
        return new ContentResult(content(r.content, r.structuredContent), r.isError === true)
      } catch (err) {
        throw new ToolError(`${cur.label}: ${cleanError(cur.id, err)}`)
      } finally {
        l.busy--
        turnCalls.get(turn.id)?.delete(ac)
        if (l.conn === conn) touch(cur.id, l)
      }
    }
  }
}

// every tool of the servers on for the turn's brand. with no turn (the tool list in Settings)
// it's the servers on for any brand, so their tools show up there too
export function mcpServerTools(turn?: Turn): GatewayTool[] {
  const out: GatewayTool[] = []
  for (const s of serversNow()) {
    if (turn ? !s.brands[turn.brandId] : Object.keys(s.brands).length === 0) continue
    const defs = cachedTools(s.id)?.defs ?? []
    for (const t of toolEntries(s.id, defs)) out.push(serverTool(s, t))
  }
  return out
}
