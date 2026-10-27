import type { DiffLine, Risk, ToolAnnotations } from '@shared/gateway'
import type { Turn } from '../mcp/turns'
import type { JsonSchema } from './validate'

export type { Turn }

// a mistake the agent can fix, its message goes back as is
export class ToolError extends Error {}

// a tool that hands back a picture, e.g. the phone screen
export class ImageResult {
  constructor(
    readonly png: Buffer,
    readonly note: string
  ) {}
}

export interface GatewayTool {
  name: string
  // short and plain, for approval cards and the audit list
  title: string
  description: string
  inputSchema: JsonSchema
  risk: Risk
  // defaults come from the risk level, see annotationsFor
  annotations?: Partial<Omit<ToolAnnotations, 'title'>>
  // asks the user every time, the policy can't skip it
  alwaysAsk?: boolean
  // asks this time even if the policy says auto, with why. e.g. finishing a stage that isn't auto
  mustAsk?: (turn: Turn, args: Record<string, unknown>) => Promise<string | null>
  // one plain line for the approval card
  summarize?: (turn: Turn, args: Record<string, unknown>) => Promise<string> | string
  // a diff for the approval card, throws ToolError when the change can't apply
  diff?: (turn: Turn, args: Record<string, unknown>) => Promise<DiffLine[]>
  run: (turn: Turn, args: Record<string, unknown>) => Promise<unknown>
}

export function annotationsFor(tool: GatewayTool): ToolAnnotations {
  const r = tool.risk
  return {
    title: tool.title,
    readOnlyHint: r === 'read',
    destructiveHint: r === 'publish' || r === 'spend',
    idempotentHint: r === 'read',
    openWorldHint: r === 'publish' || r === 'spend',
    ...tool.annotations
  }
}

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
