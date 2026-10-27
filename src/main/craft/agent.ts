import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { APPS, fill, spec } from './catalog'
import { craftRoot, installed } from './install'
import { cleanEnv, onAppExit, onAppStart, runningApp, type Running } from './launch'
import { McpClient, type McpCallResult } from './mcp'
import { appFiles } from './paths'
import { resolveInProject, safeName, uniqueName, type McpToolDef } from './rules'
import { changed, setLive } from './state'

// the agent's connection to each app's own MCP server, <id>-cli mcp. bridge mode drives the
// open window (same token as the window, from main's environment), headless mode runs the
// app's engine on the project file with no window. one connection per app at a time

export interface Session {
  appId: string
  mode: 'bridge' | 'headless'
  // headless: the project file it loaded, null for an empty one
  file: string | null
  folder: string
  brandId: string
  projectId: string
  client: McpClient
  ready: Promise<void>
  // headless: something changed since the last save
  dirty: boolean
  idle: NodeJS.Timeout | null
}

const sessions = new Map<string, Session>()
// a headless engine nobody used for this long is saved and stopped
const IDLE_MS = 10 * 60_000

// ---- the apps' tool lists, kept per version so tools/list doesn't need a running app ----

interface ToolCache {
  version: string
  headless: McpToolDef[]
  // tools only the bridge has (ui_*), known once a window was driven
  bridge: McpToolDef[]
}

const toolCache = new Map<string, ToolCache>()
const cacheFile = (id: string): string => join(craftRoot(), id, 'tools.json')

export function cachedTools(appId: string): { tool: McpToolDef; bridgeOnly: boolean }[] {
  const c = toolCache.get(appId)
  if (!c) return []
  const names = new Set(c.headless.map((t) => t.name))
  // some apps list their ui_ tools headless too, they still need a window
  const hasBridge = !!spec(appId).bridgeArgs
  return [
    ...c.headless.map((tool) => ({ tool, bridgeOnly: hasBridge && tool.name.startsWith('ui_') })),
    ...c.bridge.filter((t) => !names.has(t.name)).map((tool) => ({ tool, bridgeOnly: true }))
  ]
}

async function saveCache(appId: string): Promise<void> {
  const c = toolCache.get(appId)
  if (c) await fs.writeFile(cacheFile(appId), JSON.stringify(c)).catch(() => {})
}

function storeTools(appId: string, version: string, mode: Session['mode'], tools: McpToolDef[]): void {
  const prev = toolCache.get(appId)
  const c: ToolCache = prev?.version === version ? { ...prev } : { version, headless: [], bridge: [] }
  if (mode === 'headless') c.headless = tools
  else c.bridge = tools
  toolCache.set(appId, c)
  void saveCache(appId)
  // the gateway lists tools from this cache, a change shows on the next tools/list
  changed(appId)
}

// loads what's on disk, and asks a headless engine for its tools when there's nothing for this version
export async function loadToolCache(appId: string): Promise<void> {
  const have = await installed(appId)
  if (!have || !spec(appId).agent) {
    toolCache.delete(appId)
    return
  }
  try {
    const c = JSON.parse(await fs.readFile(cacheFile(appId), 'utf8')) as ToolCache
    if (c.version === have.version && Array.isArray(c.headless) && c.headless.length) {
      toolCache.set(appId, { version: c.version, headless: c.headless, bridge: Array.isArray(c.bridge) ? c.bridge : [] })
      return
    }
    // a new version keeps the old bridge list until a window is driven again
    toolCache.set(appId, { version: have.version, headless: c.headless ?? [], bridge: c.bridge ?? [] })
  } catch {
    // none yet
  }
  const client = new McpClient({ command: have.cli, args: ['mcp', ...spec(appId).headlessArgs(null, null)], env: cleanEnv({}) as Record<string, string>, cwd: have.dir })
  try {
    await client.start()
    storeTools(appId, have.version, 'headless', await client.listTools())
  } catch (err) {
    console.error(`craft: couldn't list ${appId}'s tools`, err)
  } finally {
    client.close()
  }
}

export async function loadAllToolCaches(): Promise<void> {
  for (const a of APPS) await loadToolCache(a.id).catch(() => {})
}

// ---- sessions ----

function agentState(appId: string): void {
  const s = sessions.get(appId)
  setLive(appId, { agent: s ? s.mode : 'off' })
}

async function startSession(s: Omit<Session, 'client' | 'ready' | 'dirty' | 'idle'>, run: Running | null): Promise<Session> {
  const have = await installed(s.appId)
  if (!have) throw new Error(`${spec(s.appId).name} isn't installed`)
  const sp = spec(s.appId)
  const bridge = s.mode === 'bridge' && run && sp.bridgeArgs ? sp.bridgeArgs(run.port) : null
  if (s.mode === 'bridge' && !bridge) throw new Error(`${sp.name} can't be driven while its window is open`)
  const args = ['mcp', ...(bridge ?? sp.headlessArgs(s.file, s.folder))]
  // the bridge needs the window's token, headless gets none
  const env: Record<string, string> = bridge && run && sp.tokenEnv ? { [sp.tokenEnv]: run.token } : {}
  const client = new McpClient({ command: have.cli, args, env: cleanEnv(env) as Record<string, string>, cwd: s.folder, timeoutMs: 10 * 60_000 })
  const session: Session = { ...s, client, ready: Promise.resolve(), dirty: false, idle: null }
  session.ready = client.start().then(async () => {
    storeTools(s.appId, have.version, s.mode, await client.listTools())
    // apps without a file flag load it with a tool
    if (s.mode === 'headless' && s.file && sp.openTool) check(await client.callTool(...step(fill(sp.openTool, s.file))), `open ${basename(s.file)}`)
  })
  sessions.set(s.appId, session)
  agentState(s.appId)
  client.onExit((why) => {
    if (sessions.get(s.appId) !== session) return
    sessions.delete(s.appId)
    if (session.idle) clearTimeout(session.idle)
    if (why !== 'closed') {
      console.error(`craft: ${s.appId} agent connection ${why}`)
      setLive(s.appId, { agent: 'error' })
      if (s.mode === 'bridge') retryBridge(s.appId)
    } else agentState(s.appId)
  })
  try {
    await session.ready
  } catch (err) {
    client.close()
    if (sessions.get(s.appId) === session) sessions.delete(s.appId)
    setLive(s.appId, { agent: 'error' })
    throw err
  }
  return session
}

// a crashed bridge comes back while the window is open: 1s, 2s, 4s... up to 30s
const backoff = new Map<string, number>()
function retryBridge(appId: string): void {
  const run = runningApp(appId)
  if (!run) return
  const wait = Math.min(30_000, (backoff.get(appId) ?? 500) * 2)
  backoff.set(appId, wait)
  setTimeout(() => {
    const now = runningApp(appId)
    if (!now || now !== run || sessions.has(appId)) return
    void startBridge(now).catch(() => {})
  }, wait)
}

async function startBridge(run: Running): Promise<Session> {
  const s = await startSession(
    { appId: run.appId, mode: 'bridge', file: run.file, folder: run.folder, brandId: run.brandId, projectId: run.projectId },
    run
  )
  backoff.delete(run.appId)
  return s
}

// writes a headless engine's changes back to its file
async function saveHeadless(s: Session): Promise<void> {
  const saveStep = spec(s.appId).save
  if (s.mode !== 'headless' || !s.dirty || !s.file || !saveStep) return
  try {
    check(await s.client.callTool(...step(fill(saveStep, s.file))), 'save')
    s.dirty = false
  } catch (err) {
    console.error(`craft: ${s.appId} couldn't save`, err)
  }
}

export async function saveSession(appId: string): Promise<void> {
  const s = sessions.get(appId)
  if (s) await saveHeadless(s)
}

// stops the app's session. a headless engine with changes saves first, if the app says how
export async function stopSession(appId: string, save = true): Promise<void> {
  const s = sessions.get(appId)
  if (!s) return
  sessions.delete(appId)
  if (s.idle) clearTimeout(s.idle)
  if (save) await saveHeadless(s)
  s.client.close()
  agentState(appId)
}

function touch(s: Session): void {
  if (s.mode !== 'headless') return
  if (s.idle) clearTimeout(s.idle)
  s.idle = setTimeout(() => void stopSession(s.appId), IDLE_MS)
}

// the connection for a call on this project: the open window when it's showing this project,
// else a headless engine on the project's main file
export async function sessionFor(
  appId: string,
  brandId: string,
  projectId: string,
  folder: string,
  mainFile: () => Promise<string | null>,
  needsWindow: boolean
): Promise<Session> {
  const run = runningApp(appId)
  const onWindow = !!run && run.brandId === brandId && run.projectId === projectId
  if (onWindow && !spec(appId).bridgeArgs) {
    throw new Error(`${spec(appId).name} can't be driven while its window is open on this project. ask the user to close it first`)
  }
  if (needsWindow && !onWindow) {
    throw new Error(`this needs ${spec(appId).name}'s window open on this project, use craft_open first`)
  }
  const have = sessions.get(appId)
  if (onWindow) {
    if (have?.mode === 'bridge') {
      await have.ready
      return have
    }
    if (have) await stopSession(appId)
    return startBridge(run!)
  }
  if (have?.mode === 'headless' && have.brandId === brandId && have.projectId === projectId) {
    await have.ready
    touch(have)
    return have
  }
  // the window is showing another project: its bridge stays, the headless engine can't share the slot
  if (have?.mode === 'bridge') throw new Error(`${spec(appId).name} is open on another project. ask the user to close it, or work on that project`)
  if (have) await stopSession(appId)
  const file = await mainFile()
  const s = await startSession({ appId, mode: 'headless', file, folder, brandId, projectId }, null)
  touch(s)
  return s
}

const step = (st: { name: string; args: Record<string, unknown> }): [string, Record<string, unknown>, { timeoutMs: number }] => [
  st.name,
  st.args,
  { timeoutMs: 60_000 }
]

function check(r: McpCallResult, what: string): void {
  if (!r.isError) return
  const text = r.content
    .map((c) => c.text ?? '')
    .join(' ')
    .trim()
  throw new Error(`couldn't ${what}: ${text.slice(0, 300) || 'the app said no'}`)
}

// a new empty file for the app in the folder, made by a headless engine with the app's own
// new and save tools. null when the app can't, then it opens empty and the user saves
async function newProjectFile(appId: string, folder: string, projectName: string): Promise<string | null> {
  const sp = spec(appId)
  const have = await installed(appId)
  if (!have || !sp.newFile) return null
  const taken = await fs.readdir(folder).catch(() => [] as string[])
  const ext = sp.exts[0]
  const stem = uniqueName(
    safeName(projectName),
    taken.map((n) => (extname(n).toLowerCase() === ext ? basename(n, extname(n)) : n))
  )
  const file = join(folder, `${stem}${ext}`)
  const client = new McpClient({ command: have.cli, args: ['mcp', ...sp.headlessArgs(null, folder)], env: cleanEnv({}) as Record<string, string>, cwd: folder })
  try {
    await client.start()
    for (const st of sp.newFile) check(await client.callTool(...step(fill(st, file))), 'make a new file')
    await fs.access(file)
    return file
  } catch (err) {
    console.error(`craft: ${appId} couldn't make a new file, it opens empty`, err)
    return null
  } finally {
    client.close()
  }
}

// the file to open: the one asked for (a name in the folder), else the newest of the app's
// type, else a new empty one
export async function pickFile(appId: string, folder: string, projectName: string, file: string | null | undefined): Promise<string | null> {
  if (file) {
    const full = resolveInProject(folder, file)
    await fs.access(full).catch(() => {
      throw new Error(`${file} isn't in the project folder`)
    })
    return full
  }
  const list = await appFiles(folder, appId)
  if (list.length) return join(folder, list[0].name)
  return newProjectFile(appId, folder, projectName)
}

export function markDirty(appId: string): void {
  const s = sessions.get(appId)
  if (s) s.dirty = true
}

export function sessionOf(appId: string): Session | null {
  return sessions.get(appId) ?? null
}

export function setupAgentSessions(): void {
  // open() stops a headless engine on the app (saving it) before the window starts
  onAppStart((run) => {
    if (!spec(run.appId).agent) return
    void (async () => {
      // the window needs a moment before its control port answers
      await new Promise((r) => setTimeout(r, 1500))
      if (runningApp(run.appId) === run && !sessions.has(run.appId)) await startBridge(run).catch(() => retryBridge(run.appId))
    })()
  })
  onAppExit((run) => {
    const s = sessions.get(run.appId)
    if (s?.mode === 'bridge') void stopSession(run.appId, false)
  })
}

export async function stopAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id)))
}
