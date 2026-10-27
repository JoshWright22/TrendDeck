import type { AuditDecision, DiffLine, Risk, ToolInfo } from '@shared/gateway'
import { appendAudit } from './audit'
import { requestApproval, turnAllowed } from './approvals'
import { decide } from './decide'
import { getPolicy } from './policy'
import { redact, redactText } from './redact'
import { knownSecrets } from './secrets'
import { annotationsFor, ContentResult, ImageResult, ToolError, type GatewayTool, type ToolResult, type Turn } from './types'
import { validateArgs } from './validate'

const tools = new Map<string, GatewayTool>()
// tools that come and go, e.g. the craft apps' own tools once an app is installed.
// asked on every list and call, so tools/list always shows what's there now
const sources: (() => GatewayTool[])[] = []

export function registerToolSource(fn: () => GatewayTool[]): void {
  sources.push(fn)
}

function dynamicTools(): GatewayTool[] {
  const out: GatewayTool[] = []
  for (const fn of sources) {
    try {
      for (const t of fn()) if (!tools.has(t.name)) out.push(t)
    } catch (err) {
      console.error('a gateway tool source failed', err)
    }
  }
  return out
}

function findTool(name: string): GatewayTool | undefined {
  return tools.get(name) ?? dynamicTools().find((t) => t.name === name)
}

export function registerTools(list: GatewayTool[]): void {
  for (const t of list) {
    if (tools.has(t.name)) throw new Error(`two gateway tools called ${t.name}`)
    tools.set(t.name, t)
  }
}

export function allTools(): GatewayTool[] {
  return [...tools.values(), ...dynamicTools()]
}

export function toolInfo(): ToolInfo[] {
  return allTools().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    risk: t.risk,
    annotations: annotationsFor(t),
    alwaysAsk: t.alwaysAsk === true
  }))
}

// what tools/list sends
export function mcpToolList(): Record<string, unknown>[] {
  return allTools().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: annotationsFor(t)
  }))
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

// args as they go in the audit log and on approval cards: redacted, long text cut short
function shortArgs(args: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return clip(v, 300)
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => cut(x, depth + 1))
    if (v && typeof v === 'object' && depth < 4) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x, depth + 1)]))
    }
    return v
  }
  return cut(redact(args, known), 0) as Record<string, unknown>
}

function text(body: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text: body }], isError: true } : { content: [{ type: 'text', text: body }] }
}

function denyText(tool: GatewayTool, decision: AuditDecision, note: string): string {
  const base =
    decision === 'timeout'
      ? `the user didn't answer the approval for ${tool.name} in time, so it didn't run`
      : decision === 'cancelled'
        ? `${tool.name} didn't run, ${note || 'the approval was cancelled'}`
        : `the user said no to ${tool.name}, it didn't run`
  return decision === 'denied' && note ? `${base}. they said: ${note}` : base
}

// every agent tool call goes through here: known tool, strict args, policy, approval,
// run, redact, audit. nothing an agent gets back skips the redaction
export async function callGatewayTool(turn: Turn, name: string, rawArgs: unknown): Promise<ToolResult> {
  const started = Date.now()
  const known = await knownSecrets(turn.brandId)
  const tool = findTool(name)
  const audit = (risk: Risk | null, args: Record<string, unknown>, decision: AuditDecision, ok: boolean, result: string): void => {
    appendAudit({
      brandId: turn.brandId,
      threadId: turn.threadId,
      turnId: turn.id,
      tool: clip(name, 80),
      risk,
      args: shortArgs(args, known),
      decision,
      ok,
      result: clip(redactText(result, known), 300),
      ms: Date.now() - started
    })
  }
  const rawObj = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}

  if (!tool) {
    const msg = `no tool called ${name}. tools: ${allTools()
      .map((t) => t.name)
      .join(', ')}`
    audit(null, rawObj, 'invalid', false, `unknown tool`)
    return text(msg, true)
  }
  const v = validateArgs(tool.inputSchema, rawArgs)
  if (!v.ok) {
    const msg = `${tool.name} didn't run, its arguments need fixing:\n- ${v.errors.join('\n- ')}`
    audit(tool.risk, rawObj, 'invalid', false, v.errors.join('; '))
    return text(redactText(msg, known), true)
  }
  const args = v.value

  let decision: AuditDecision = 'auto'
  try {
    const policy = await getPolicy(turn.brandId)
    const why = tool.mustAsk ? await tool.mustAsk(turn, args) : null
    const rule = decide(policy, tool, turnAllowed(turn.id), why !== null)
    if (rule === 'deny') {
      audit(tool.risk, args, 'blocked', false, 'turned off by policy')
      return text(`the user turned ${tool.name} off for this brand. don't try it another way, ask them if it's needed`, true)
    }
    if (rule === 'ask') {
      let diff: DiffLine[] | null = null
      if (tool.diff) diff = await tool.diff(turn, args)
      const line = tool.summarize ? await tool.summarize(turn, args) : `${tool.title}`
      const summary = redactText(why ? `${line}. ${why}` : line, known)
      const out = await requestApproval(
        {
          brandId: turn.brandId,
          threadId: turn.threadId,
          turnId: turn.id,
          tool: tool.name,
          title: tool.title,
          risk: tool.risk,
          args: shortArgs(args, known),
          summary,
          diff: diff ? redact(diff, known) : null,
          alwaysAsk: tool.alwaysAsk === true || why !== null
        },
        policy.approvalTimeoutSec
      )
      if (out.decision !== 'approved') {
        const d: AuditDecision = out.decision
        audit(tool.risk, args, d, false, out.note || d)
        return text(redactText(denyText(tool, d, out.note), known), true)
      }
      decision = 'approved'
    }

    const result = await tool.run(turn, args)
    if (result instanceof ImageResult) {
      audit(tool.risk, args, decision, true, `image, ${result.png.length} bytes. ${result.note}`)
      return {
        content: [
          { type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: redactText(result.note, known) }
        ]
      }
    }
    if (result instanceof ContentResult) {
      const content = result.content.map((c) => (c.type === 'text' ? { type: 'text' as const, text: redactText(c.text, known) } : c))
      const textPart = content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
      const images = content.length - content.filter((c) => c.type === 'text').length
      audit(tool.risk, args, decision, !result.isError, `${images ? `${images} image(s). ` : ''}${textPart}`)
      return result.isError ? { content, isError: true } : { content }
    }
    const body = typeof result === 'string' ? redactText(result, known) : JSON.stringify(redact(result, known), null, 2)
    audit(tool.risk, args, decision, true, body)
    return text(body ?? 'done')
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `failed: ${err instanceof Error ? err.message : String(err)}`
    const clean = redactText(msg, known)
    audit(tool.risk, args, decision, false, clean)
    return text(clean, true)
  }
}
