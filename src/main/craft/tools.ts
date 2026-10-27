import { promises as fs } from 'node:fs'
import { basename, dirname } from 'node:path'
import { projectIdForThread, type Project } from '@shared/workspace'
import { onTurnClosed } from '../mcp/turns'
import { brandOf } from '../gateway/tools/common'
import { ContentResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { obj, oneOf, str } from '../gateway/validate'
import type { JsonSchema } from '../gateway/validate'
import { cachedTools, markDirty, pickFile, saveSession, sessionFor } from './agent'
import { countsAsEdit } from '@shared/craft-embed'
import { APPS, spec } from './catalog'
import type { McpCallResult, McpContent } from './mcp'
import { appFiles, findProject, projectFolder } from './paths'
import {
  commandIds,
  deletesFiles,
  gatewayName,
  gatewaySchema,
  hideRoot,
  isInside,
  PathError,
  rewritePaths,
  riskFor,
  type McpToolDef
} from './rules'
import { liveOf, status } from './state'

// the craft apps for the agent: craft_list, craft_open, craft_files, and every installed app's
// own MCP tools as <app>_<tool>. the agent names a TrendDeck project by id (its chat's project
// when it doesn't), never a folder: paths in its arguments are relative to that project's
// folder and anything outside it is refused

const PROJECT_ARG = str("the TrendDeck project (one video) to work on, by id. leave it out for this chat's project")

function projectOf(turn: Turn, projectId: unknown): Project {
  const brand = brandOf(turn)
  const id = typeof projectId === 'string' && projectId ? projectId : projectIdForThread(brand.projects, turn.threadId ?? '')
  const p = brand.projects.find((x) => x.id === id)
  if (!p) {
    const list = brand.projects.map((x) => `${x.id} (${x.name})`).join(', ')
    throw new ToolError(`no project ${id} in this brand. projects: ${list}`)
  }
  return p
}

// calls still running when their turn ends are cancelled
const turnCalls = new Map<string, Set<AbortController>>()

function forTurn(turnId: string): AbortController {
  const ac = new AbortController()
  let set = turnCalls.get(turnId)
  if (!set) turnCalls.set(turnId, (set = new Set()))
  set.add(ac)
  return ac
}

// the app's MCP content as gateway content. the folder's full path is shown as "."
function content(items: McpContent[], folder: string): ContentResult['content'] {
  const out: ContentResult['content'] = []
  for (const c of items) {
    if (c.type === 'text' && typeof c.text === 'string') out.push({ type: 'text', text: hideRoot(c.text, folder) })
    else if (c.type === 'image' && typeof c.data === 'string') out.push({ type: 'image', data: c.data, mimeType: c.mimeType ?? 'image/png' })
    else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const r = c.resource as { uri?: string; text?: string; mimeType?: string }
      out.push({ type: 'text', text: hideRoot(r.text ?? `resource ${r.uri ?? ''} (${r.mimeType ?? 'binary'})`, folder) })
    } else out.push({ type: 'text', text: `(${c.type} content left out)` })
  }
  return out.length ? out : [{ type: 'text', text: 'done' }]
}

// ---- around the agent's edits in an app. cards/turn-edits.ts makes one undo group of a reply's
// edits and shows the app in the chat. a hook failing never stops the edit ----

export interface CraftEditCall {
  turn: Turn
  appId: string
  projectId: string
  folder: string
  tool: string
  args: Record<string, unknown>
}

const beforeEdits: ((c: CraftEditCall) => Promise<void>)[] = []
const afterEdits: ((c: CraftEditCall, ok: boolean) => void)[] = []

export function onCraftEdit(before: (c: CraftEditCall) => Promise<void>, after: (c: CraftEditCall, ok: boolean) => void): void {
  beforeEdits.push(before)
  afterEdits.push(after)
}

// one of an app's own tools called by TrendDeck itself (not the agent) on a project: the open
// window when it shows the project, else the headless engine
export async function appCall(
  brandId: string,
  projectId: string,
  appId: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { needsWindow?: boolean; timeoutMs?: number; edits?: boolean } = {}
): Promise<McpCallResult> {
  const { project } = findProject(brandId, projectId)
  const folder = await projectFolder(brandId, projectId)
  const session = await sessionFor(appId, brandId, projectId, folder, () => pickFile(appId, folder, project.name, null), !!opts.needsWindow)
  const r = await session.client.callTool(tool, args, { timeoutMs: opts.timeoutMs ?? 60_000 })
  if (opts.edits) markDirty(appId)
  return r
}

// the json an app's tool answered with, its first text part
export function resultJson(r: McpCallResult): unknown {
  const text = r.content.find((c) => c.type === 'text' && typeof c.text === 'string')?.text
  if (r.isError) throw new Error((text ?? 'the app said no').slice(0, 300))
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function appTool(appId: string, t: McpToolDef, bridgeOnly: boolean): GatewayTool {
  const sp = spec(appId)
  const { risk, alwaysAsk } = riskFor(t)
  const schema = gatewaySchema(t.inputSchema) as unknown as JsonSchema
  schema.properties = { ...(schema.properties ?? {}), projectId: PROJECT_ARG }
  const where = bridgeOnly
    ? `Works on ${sp.name}'s open window, open it with craft_open first.`
    : `Works on the project's ${sp.name} file: the open window when it shows this project, otherwise ${sp.name} runs without a window on the project's newest ${sp.exts[0]} file and saves it when this turn ends.`
  return {
    name: gatewayName(appId, t.name),
    title: `${sp.name}: ${t.title ?? t.annotations?.title ?? t.name}`,
    description: `${t.description ?? t.name}\n\n${where} File paths are relative to the project folder, files outside it are refused.`,
    inputSchema: schema,
    risk,
    alwaysAsk,
    annotations: {
      destructiveHint: t.annotations?.destructiveHint === true,
      idempotentHint: t.annotations?.idempotentHint === true,
      openWorldHint: false
    },
    mustAsk: async (_turn, args) => (commandIds(args).some(deletesFiles) ? 'it may delete files from the project folder' : null),
    summarize: (turn, args) => {
      const ids = commandIds(args)
      return `${sp.name}: ${t.name}${ids.length ? ` ${ids.join(', ')}` : ''} on ${projectOf(turn, args.projectId).name}`
    },
    run: async (turn, args) => {
      const { projectId, ...rest } = args
      const project = projectOf(turn, projectId)
      const folder = await projectFolder(turn.brandId, project.id)
      let callArgs: Record<string, unknown>
      const paths: string[] = []
      try {
        callArgs = rewritePaths(rest, folder, '', paths) as Record<string, unknown>
      } catch (err) {
        if (err instanceof PathError) throw new ToolError(err.message)
        throw err
      }
      // the apps don't make folders, so exports/x.png works the first time too
      if (risk !== 'read') {
        for (const p of paths) if (dirname(p) !== folder && isInside(folder, dirname(p))) await fs.mkdir(dirname(p), { recursive: true }).catch(() => {})
      }
      const edit: CraftEditCall | null = risk !== 'read' && countsAsEdit(t.name, callArgs) ? { turn, appId, projectId: project.id, folder, tool: t.name, args: callArgs } : null
      if (edit) {
        for (const fn of beforeEdits) await fn(edit).catch((err) => console.error('craft: an edit hook failed', err))
      }
      let session
      try {
        session = await sessionFor(appId, turn.brandId, project.id, folder, () => pickFile(appId, folder, project.name, null), bridgeOnly)
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err))
      }
      const ac = forTurn(turn.id)
      try {
        // progress keeps a long export from timing out, it isn't shown anywhere yet
        const r = await session.client.callTool(t.name, callArgs, { signal: ac.signal, timeoutMs: 10 * 60_000, onProgress: () => {} })
        if (risk !== 'read') markDirty(appId)
        if (edit) for (const fn of afterEdits) fn(edit, r.isError !== true)
        return new ContentResult(content(r.content, folder), r.isError === true)
      } catch (err) {
        throw new ToolError(`${sp.name}: ${hideRoot(err instanceof Error ? err.message : String(err), folder)}`)
      } finally {
        turnCalls.get(turn.id)?.delete(ac)
      }
    }
  }
}

// every installed app's own tools, from the cache agent.ts keeps
export function craftAppTools(): GatewayTool[] {
  const out: GatewayTool[] = []
  for (const a of APPS) {
    if (!a.agent || liveOf(a.id).install.kind !== 'installed') continue
    for (const { tool, bridgeOnly } of cachedTools(a.id)) out.push(appTool(a.id, tool, bridgeOnly))
  }
  return out
}

const APP_ARG = oneOf('the craft app, by id', APPS.map((a) => a.id))

export function craftTools(open: (turn: Turn, appId: string, projectId: string, file: string | null) => Promise<unknown>): GatewayTool[] {
  return [
    {
      name: 'craft_list',
      title: 'List the craft apps',
      description:
        "The Craft App Suite: native editors (video, photo, audio, vector, layout, documents...) TrendDeck can install, open over its workspace and that you can drive through their own tools, named <app>_<tool>. Shows each app's install state, whether its window is open and on which project, and how you're connected to it.",
      inputSchema: obj(),
      risk: 'read',
      run: async (turn) => {
        const brand = brandOf(turn)
        const apps = APPS.map((a) => {
          const s = status(a.id)
          return {
            app: a.id,
            name: a.name,
            for: a.blurb,
            installed: s.install.kind === 'installed' ? s.install.version : s.install.kind === 'installing' ? 'installing' : false,
            open: s.running,
            projectId: s.brandId === brand.id ? s.projectId : null,
            openElsewhere: s.running && s.brandId !== brand.id,
            openFile: s.brandId === brand.id && s.file ? basename(s.file) : null,
            connection: s.agent,
            fileTypes: a.exts,
            tools: cachedTools(a.id).length ? `${a.id}_*` : null
          }
        })
        return { apps, projects: brand.projects.map((p) => ({ id: p.id, name: p.name })) }
      }
    },
    {
      name: 'craft_files',
      title: "List a project's files for a craft app",
      description: "The files of an app's types in a project's folder, newest first. Names only, use them as paths in the app's tools.",
      inputSchema: obj({ app: APP_ARG, projectId: PROJECT_ARG }, ['app']),
      risk: 'read',
      run: async (turn, args) => {
        const project = projectOf(turn, args.projectId)
        const folder = await projectFolder(turn.brandId, project.id)
        const files = await appFiles(folder, String(args.app))
        return { project: project.name, files: files.map((f) => ({ name: f.name, modified: new Date(f.modified).toISOString() })) }
      }
    },
    {
      name: 'craft_open',
      title: 'Open a craft app',
      description:
        "Opens a real interactive Craft editor inside the chat for the selected brand/project, so the user can edit manually while you use the app's available MCP tools. Every app in craft_list can be opened this way; automation depends on the app's connection and exposed tools. Installs it from GitHub first if needed. file is a name in the project folder, leave it out for the newest file of the app's type (a new one is made when there's none).",
      inputSchema: obj({ app: APP_ARG, projectId: PROJECT_ARG, file: str('a file name in the project folder', 260) }, ['app']),
      risk: 'edit',
      mustAsk: async (_turn, args) =>
        liveOf(String(args.app)).install.kind === 'installed' ? null : `${spec(String(args.app)).name} isn't installed, this downloads it from GitHub (about 100 MB)`,
      summarize: (turn, args) => `Open ${spec(String(args.app)).name} on ${projectOf(turn, args.projectId).name}`,
      run: async (turn, args) => {
        const project = projectOf(turn, args.projectId)
        try {
          await open(turn, String(args.app), project.id, typeof args.file === 'string' ? args.file : null)
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err))
        }
        const s = status(String(args.app))
        return { opened: s.app.name, project: project.name, file: s.file ? basename(s.file) : null, connection: s.agent }
      }
    }
  ]
}

// a turn ending cancels its calls and saves what headless engines changed
export function setupCraftTurns(): void {
  onTurnClosed((turn) => {
    for (const ac of turnCalls.get(turn.id) ?? []) ac.abort('the chat turn ended')
    turnCalls.delete(turn.id)
    for (const a of APPS) void saveSession(a.id).catch((error) => console.error(`craft: ${a.id} changes are still unsaved`, error))
  })
}
