import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import { spec, type ToolStep } from './catalog'
import type { McpCallResult } from './mcp'
import type { McpToolDef } from './rules'

export interface LiveSavePlan {
  inspect: string
  save: ToolStep
}

export class LiveIdentityError extends Error {
  constructor() {
    super('The active editor document could not be verified. Return to the original project document and save it in the editor before trying again.')
  }
}

export function liveSaveCall(tool: string, args: Record<string, unknown>, saveTool: string): { saves: boolean; targetsPath: boolean } {
  if (tool === 'command_run' || tool === 'command_batch') {
    const commands = tool === 'command_run' ? [args] : Array.isArray(args.steps) ? args.steps : []
    let saves = false
    let targetsPath = false
    for (const command of commands) {
      if (!command || typeof command !== 'object') continue
      const step = command as Record<string, unknown>
      if (step.id !== 'file.save' && step.id !== 'file.saveAs' && step.id !== 'file.saveCopy') continue
      saves = true
      const params = step.params
      if (step.id === 'file.saveAs' || (step.id === 'file.save' && params && typeof params === 'object' && 'path' in params)) targetsPath = true
    }
    return { saves, targetsPath }
  }
  return { saves: tool === saveTool, targetsPath: tool === saveTool && 'path' in args }
}

export function switchesLiveDocument(appId: string, tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'command_run' || tool === 'command_batch') {
    const commands = tool === 'command_run' ? [args] : Array.isArray(args.steps) ? args.steps : []
    return commands.some((command) => command && typeof command === 'object' && ['file.open', 'file.new', 'file.saveAs', 'file.close'].includes(String((command as Record<string, unknown>).id)))
  }
  const app = spec(appId)
  return tool === app.openTool?.name || tool === 'doc_select' || !!app.newFile?.some((step) => step.name !== app.save?.name && step.name === tool)
}

export function liveSavePlan(appId: string, version: string, tools: McpToolDef[]): LiveSavePlan | null {
  let plan: LiveSavePlan
  if (appId === 'filmcraft' && version === '0.13.0') {
    plan = { inspect: 'project_inspect', save: { name: 'command_run', args: { id: 'file.save', params: {} } } }
  } else if (appId === 'photocraft' && version === '0.16.0') {
    plan = { inspect: 'doc_inspect', save: { name: 'doc_save', args: {} } }
  } else return null
  const inspector = tools.find((tool) => tool.name === plan.inspect)
  const save = tools.find((tool) => tool.name === plan.save.name)
  if (!inspector || inspector.annotations?.readOnlyHint !== true || !save) return null
  if (Array.isArray(inspector.inputSchema?.required) && inspector.inputSchema.required.length) return null
  if (appId === 'photocraft' && Array.isArray(save.inputSchema?.required) && save.inputSchema.required.length) return null
  return plan
}

export async function verifyLiveFile(expected: string, inspect: () => Promise<McpCallResult>): Promise<void> {
  try {
    const result = await inspect()
    if (result.isError) throw new LiveIdentityError()
    const value = result.structuredContent ?? JSON.parse(result.content.find((part) => part.type === 'text' && typeof part.text === 'string')?.text ?? '')
    if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' || !isAbsolute(value.path)) throw new LiveIdentityError()
    const [active, original] = await Promise.all([fs.realpath(value.path), fs.realpath(expected)])
    if (active !== original) throw new LiveIdentityError()
  } catch {
    throw new LiveIdentityError()
  }
}
