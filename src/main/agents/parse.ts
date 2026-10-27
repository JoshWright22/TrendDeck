import type { UsageWindow, WorkStep } from '@shared/chat'

// reads the json lines agent clis print and turns them into text, thinking and work
// log steps. a line that isn't json goes through as text so nothing gets lost

export interface Sink {
  text: (t: string) => void
  thinking: (t: string) => void
  thinkingTokens: (n: number) => void
  step: (s: WorkStep) => void
  session: (id: string) => void
  contextTokens: (n: number) => void
  limits: (w: UsageWindow[]) => void
}

export interface Parser {
  line: (l: string) => void
  error: () => string
}

// the claude parser also takes already parsed events, the agent sdk hands those over
export interface ClaudeParser extends Parser {
  event: (ev: Record<string, unknown>) => void
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
const short = (s: string, max = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}...` : one
}

function parse(l: string): Json | null {
  const t = l.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as Json
  } catch {
    return null
  }
}

// what a tool call looks like in the log, from its name and input
export function describeTool(name: string, input: Json): Pick<WorkStep, 'kind' | 'label' | 'detail'> {
  const n = name.toLowerCase()
  const url = str(input.url)
  const path = str(input.file_path) || str(input.path) || str(input.filePath)
  const query = str(input.query) || str(input.pattern)
  const cmd = str(input.command) || str(input.cmd)
  if (url || n.includes('fetch')) return { kind: 'page', label: 'Opened a page', detail: short(url || query) }
  if (n.includes('search')) return { kind: 'search', label: 'Searched the web', detail: short(query) }
  if (path || n.includes('read') || n.includes('write') || n.includes('edit'))
    return { kind: 'file', label: n.includes('read') ? 'Read a file' : 'Used a file', detail: short(path) }
  if (cmd || n.includes('bash') || n.includes('shell')) return { kind: 'command', label: 'Ran a command', detail: short(cmd) }
  return { kind: 'tool', label: name || 'Tool call', detail: short(JSON.stringify(input)) }
}

export class Steps {
  private open = new Map<string, WorkStep>()
  constructor(private sink: Sink) {}
  start(id: string, name: string, input: Json): void {
    const step: WorkStep = { id, ...describeTool(name, input), status: 'running', startedAt: Date.now() }
    this.open.set(id, step)
    this.sink.step(step)
  }
  // input can arrive after the start, e.g. once claude's partial json is done
  update(id: string, name: string, input: Json): void {
    const step = this.open.get(id)
    if (!step) return this.start(id, name, input)
    Object.assign(step, describeTool(name, input))
    this.sink.step({ ...step })
  }
  end(id: string, failed: boolean): void {
    const step = this.open.get(id)
    if (!step) return
    step.status = failed ? 'error' : 'done'
    step.endedAt = Date.now()
    this.open.delete(id)
    this.sink.step({ ...step })
  }
  // anything still open when the run ends
  close(): void {
    for (const id of [...this.open.keys()]) this.end(id, false)
  }
}

function windowsFrom(info: Json): UsageWindow[] {
  const names: Record<string, string> = { five_hour: '5 hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit' }
  const out: UsageWindow[] = []
  for (const [key, raw] of Object.entries(obj(info.unifiedWindows))) {
    const w = obj(raw)
    out.push({
      label: names[key] ?? key.replace(/_/g, ' '),
      used: typeof w.utilization === 'number' ? w.utilization : null,
      resetsAt: num(w.resetsAt) ? num(w.resetsAt) * 1000 : null
    })
  }
  if (out.length === 0 && info.rateLimitType) {
    const key = str(info.rateLimitType)
    out.push({
      label: names[key] ?? key,
      used: typeof info.utilization === 'number' ? info.utilization : null,
      resetsAt: num(info.resetsAt) ? num(info.resetsAt) * 1000 : null
    })
  }
  return out
}

// claude's stream-json with partial messages
export function claudeParser(sink: Sink): ClaudeParser {
  // set once partial messages show up, then whole messages are only read for tool inputs
  let partial = false
  let error = ''
  const steps = new Steps(sink)
  // content block index -> tool being streamed in
  const blocks = new Map<number, { id: string; name: string; json: string }>()
  const parser: ClaudeParser = {
    line(l) {
      const ev = parse(l)
      if (ev) parser.event(ev)
    },
    event(ev) {
      if (ev.session_id && ev.type === 'system' && ev.subtype === 'init') sink.session(str(ev.session_id))
      if (ev.type === 'stream_event') {
        partial = true
        const e = obj(ev.event)
        const index = num(e.index)
        if (e.type === 'content_block_start') {
          const b = obj(e.content_block)
          if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            blocks.set(index, { id: str(b.id), name: str(b.name), json: '' })
            steps.start(str(b.id), str(b.name), obj(b.input))
          }
        } else if (e.type === 'content_block_delta') {
          const d = obj(e.delta)
          if (d.type === 'text_delta' && d.text) {
            sink.text(str(d.text))
          } else if (d.type === 'thinking_delta' && d.thinking) {
            sink.thinking(str(d.thinking))
          } else if (d.type === 'input_json_delta') {
            const b = blocks.get(index)
            if (b) b.json += str(d.partial_json)
          }
        } else if (e.type === 'content_block_stop') {
          const b = blocks.get(index)
          if (b) {
            blocks.delete(index)
            try {
              steps.update(b.id, b.name, obj(JSON.parse(b.json || '{}')))
            } catch {
              // half a json input, keep what the start had
            }
          }
        }
      } else if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
        sink.thinkingTokens(num(ev.estimated_tokens))
      } else if (ev.type === 'assistant') {
        const content = (obj(ev.message).content as Json[] | undefined) ?? []
        for (const c of content) {
          // older versions without partial messages send whole messages
          if (c.type === 'text' && !partial) sink.text(str(c.text))
          if (c.type === 'thinking' && !partial && c.thinking) sink.thinking(str(c.thinking))
          if (c.type === 'tool_use') steps.update(str(c.id), str(c.name), obj(c.input))
        }
        const u = obj(obj(ev.message).usage)
        const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens)
        if (ctx) sink.contextTokens(ctx)
      } else if (ev.type === 'user') {
        const content = (obj(ev.message).content as Json[] | undefined) ?? []
        for (const c of Array.isArray(content) ? content : []) {
          if (c.type === 'tool_result') steps.end(str(c.tool_use_id), c.is_error === true)
        }
      } else if (ev.type === 'rate_limit_event') {
        const w = windowsFrom(obj(ev.rate_limit_info))
        if (w.length) sink.limits(w)
      } else if (ev.type === 'result') {
        steps.close()
        if (ev.is_error) {
          const errors = Array.isArray(ev.errors) ? ev.errors.filter((e) => typeof e === 'string').join('\n') : ''
          error = str(ev.result) || errors || 'The agent returned an error'
        }
      }
    },
    error: () => error
  }
  return parser
}

// codex exec --json: thread.started, item.started / item.completed, turn.completed
export function codexParser(sink: Sink): Parser {
  let error = ''
  const steps = new Steps(sink)
  const toolOf = (item: Json): [string, Json] | null => {
    switch (item.type) {
      case 'command_execution':
        return ['shell', { command: item.command }]
      case 'web_search':
        return ['web_search', { query: item.query }]
      case 'file_change':
        return ['edit', { path: ((item.changes as Json[] | undefined) ?? []).map((c) => str(c.path)).join(', ') }]
      case 'mcp_tool_call':
        return [`${str(item.server)} ${str(item.tool)}`.trim(), obj(item.arguments)]
      default:
        return null
    }
  }
  return {
    line(l) {
      const ev = parse(l)
      if (!ev) {
        if (l.trim()) sink.text(`${l}\n`)
        return
      }
      if (ev.type === 'thread.started') sink.session(str(ev.thread_id))
      const item = obj(ev.item)
      const id = str(item.id)
      if (ev.type === 'item.started') {
        const t = toolOf(item)
        if (t) steps.start(id, t[0], t[1])
      } else if (ev.type === 'item.completed') {
        if (item.type === 'agent_message') sink.text(str(item.text))
        else if (item.type === 'reasoning') sink.thinking(`${str(item.text)}\n\n`)
        else if (item.type === 'error') error = str(item.message)
        else {
          const t = toolOf(item)
          if (t) {
            steps.update(id, t[0], t[1])
            steps.end(id, item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0))
          }
        }
      } else if (ev.type === 'turn.completed') {
        steps.close()
        const u = obj(ev.usage)
        const ctx = num(u.input_tokens) + num(u.output_tokens)
        if (ctx) sink.contextTokens(ctx)
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        error = str(obj(ev.error).message) || str(ev.message) || 'The agent returned an error'
      }
    },
    error: () => error
  }
}

// cursor's agent --output-format stream-json
export function cursorParser(sink: Sink): Parser {
  let error = ''
  const steps = new Steps(sink)
  return {
    line(l) {
      const ev = parse(l)
      if (!ev) {
        if (l.trim()) sink.text(`${l}\n`)
        return
      }
      if (ev.type === 'system' && ev.session_id) sink.session(str(ev.session_id))
      if (ev.type === 'thinking' && ev.text) sink.thinking(str(ev.text))
      if (ev.type === 'assistant') {
        for (const c of (obj(ev.message).content as Json[] | undefined) ?? []) if (c.type === 'text') sink.text(str(c.text))
      }
      if (ev.type === 'tool_call') {
        const call = obj(ev.tool_call)
        const [key] = Object.keys(call)
        const name = (key ?? 'tool').replace(/ToolCall$/, '')
        const args = obj(obj(call[key ?? '']).args)
        if (ev.subtype === 'started') steps.start(str(ev.call_id), name, args)
        else if (ev.subtype === 'completed') {
          const result = obj(obj(call[key ?? '']).result)
          steps.update(str(ev.call_id), name, args)
          steps.end(str(ev.call_id), 'error' in result)
        }
      }
      if (ev.type === 'result') {
        steps.close()
        if (ev.is_error) error = str(ev.result) || 'The agent returned an error'
      }
    },
    error: () => error
  }
}
