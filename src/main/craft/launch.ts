import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { spec } from './catalog'
import { askClose, attach, forget, release } from './dock'
import { applyStaged, installed } from './install'
import { setLive } from './state'

// one window per app. it's started with a loopback control port and a fresh token in its
// environment: the token lives in main only, the renderer and the agent never see it.
// the agent's bridge (mcp.ts) inherits it the same way

export interface Running {
  appId: string
  child: ChildProcess
  pid: number
  port: number
  token: string
  file: string | null
  folder: string
  brandId: string
  projectId: string
  exited: Promise<void>
}

const running = new Map<string, Running>()
const exitHooks: ((r: Running) => void)[] = []
const startHooks: ((r: Running) => void)[] = []

export function onAppExit(fn: (r: Running) => void): void {
  exitHooks.push(fn)
}

export function onAppStart(fn: (r: Running) => void): void {
  startHooks.push(fn)
}

export function runningApp(appId: string): Running | null {
  return running.get(appId) ?? null
}

export function isRunning(appId: string): boolean {
  return running.has(appId)
}

// every control token, the gateway scrubs them from anything an agent gets back
export function controlTokens(): string[] {
  return [...running.values()].map((r) => r.token)
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })
}

export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  // other apps' tokens never leak into a child
  for (const k of Object.keys(env)) if (/_CONTROL_TOKEN$/.test(k) && !(k in extra)) delete env[k]
  return env
}

export async function launch(opts: { appId: string; brandId: string; projectId: string; folder: string; file: string | null }): Promise<Running> {
  const s = spec(opts.appId)
  const have = await installed(opts.appId)
  if (!have) throw new Error(`${s.name} isn't installed`)
  const port = await freePort()
  const token = randomBytes(32).toString('hex')
  const args = [...s.controlArgs(port), ...(opts.file ? [opts.file] : [])]
  const child = spawn(have.exe, args, {
    cwd: opts.folder,
    env: cleanEnv(s.tokenEnv ? { [s.tokenEnv]: token } : {}),
    stdio: 'ignore',
    windowsHide: false
  })
  const pid = await new Promise<number>((ok, fail) => {
    child.once('spawn', () => ok(child.pid!))
    child.once('error', fail)
  })
  let done!: () => void
  const exited = new Promise<void>((r) => (done = r))
  const r: Running = { ...opts, child, pid, port, token, exited }
  running.set(opts.appId, r)
  child.once('exit', () => {
    running.delete(opts.appId)
    forget(opts.appId)
    setLive(opts.appId, { running: false, brandId: null, projectId: null, file: null })
    for (const fn of exitHooks) fn(r)
    void applyStaged(opts.appId)
    done()
  })
  attach(opts.appId, pid)
  setLive(opts.appId, { running: true, brandId: opts.brandId, projectId: opts.projectId, file: opts.file })
  for (const fn of startHooks) fn(r)
  return r
}

// asks the app to close like its own close button, so it can ask to save. resolves when it's
// gone, or false when it's still open after the wait (the user cancelled its save prompt)
export async function close(appId: string, waitMs = 120_000): Promise<boolean> {
  const r = running.get(appId)
  if (!r) return true
  if (!askClose(r.pid)) {
    // no window found to ask, it's stuck or never showed one
    r.child.kill()
  }
  const out = await Promise.race([r.exited.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), waitMs))])
  return out
}

// TrendDeck is quitting: every app is let go as a normal window and asked to close.
// one that's still open after the wait (its save prompt is up) just stays open on its own
export async function closeAllForQuit(waitMs = 60_000): Promise<void> {
  const all = [...running.values()]
  for (const r of all) release(r.appId)
  await Promise.all(all.map((r) => close(r.appId, waitMs)))
}
