import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectError, connectionFor } from '../connection'

// the agent's FilmCraft calls while an editor in the chat comes and goes. the bug: a headless
// engine starting for a call (or for the chat's first look at the project) was stopped by the
// card taking the project over, the call failed with "the app's agent connection closed" and the
// app was left reporting a connection error, so the agent gave up on an editor that worked

const mocks = vi.hoisted(() => ({
  calls: vi.fn(),
  started: vi.fn(),
  setLive: vi.fn(),
  // a start that waits for this, null starts at once
  gate: null as Promise<void> | null,
  failStart: null as string | null
}))

vi.mock('../install', () => ({ installed: async () => ({ cli: 'test-cli', dir: '.', version: '0.13.0' }), craftRoot: () => '.' }))
vi.mock('../launch', () => ({
  cleanEnv: () => ({}), runningApp: () => null,
  onBeforeAppClose: () => {}, onAppStart: () => {}, onAppExit: () => {}
}))
vi.mock('../paths', () => ({ appFiles: async () => [] }))
vi.mock('../state', () => ({ setLive: mocks.setLive, changed: vi.fn() }))
vi.mock('../mcp', () => ({ McpClient: class {
  private closed = false
  private dead: (err: Error) => void = () => {}
  private exits: ((why: string) => void)[] = []
  start = async (): Promise<void> => {
    mocks.started()
    if (mocks.failStart) throw new Error(mocks.failStart)
    const gate = mocks.gate
    if (gate) {
      await new Promise<void>((ok, no) => {
        this.dead = no
        void gate.then(ok)
      })
    }
    if (this.closed) throw new Error("the app's agent connection closed")
  }
  listTools = async (): Promise<unknown[]> => [{ name: 'command_run' }]
  callTool = (name: string, args: unknown): Promise<unknown> => mocks.calls(name, args)
  // like the real one: closing rejects what's waiting and tells the exit handlers
  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.dead(new Error("the app's agent connection closed"))
    for (const fn of this.exits) fn('closed')
  }
  onExit = (fn: (why: string) => void): void => { this.exits.push(fn) }
} }))

let root: string
let agent: typeof import('../agent')
const file = (): string => join(root, 'main.fcproj')

function webSession(calls: string[], ready: Promise<void> = Promise.resolve()): import('../agent').Session {
  return {
    appId: 'filmcraft', mode: 'web', file: file(), folder: root, brandId: 'b1', projectId: 'p1',
    client: { callTool: async (name: string) => { calls.push(name); return { content: [{ type: 'text', text: 'web' }] } }, close: () => {} } as never,
    ready, dirty: false, idle: null, cancelAutosave: () => {}
  }
}

// what the gateway tool does: connect, call, again on the next connection after a handover
const agentCall = (tool = 'sequence_inspect'): Promise<{ content: { text?: string }[] }> =>
  agent.withSession(
    () => agent.sessionFor('filmcraft', 'b1', 'p1', root, async () => file(), false),
    (s) => agent.sessionCall(s, false, () => s.client.callTool(tool, {}) as never, { tool, args: {} })
  ) as never

const errorsReported = (): unknown[] => mocks.setLive.mock.calls.filter(([, patch]) => (patch as { agent?: string }).agent === 'error')

beforeEach(async () => {
  vi.resetModules()
  mocks.calls.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'headless' }] })
  mocks.started.mockReset()
  mocks.setLive.mockReset()
  mocks.gate = null
  mocks.failStart = null
  root = await fs.mkdtemp(join(tmpdir(), 'craft-web-handover-'))
  await fs.writeFile(file(), '{}')
  agent = await import('../agent')
})

afterEach(async () => {
  mocks.gate = null
  await agent.stopSession('filmcraft', false)
  agent.setWebReadyMs(agent.WEB_READY_MS)
  await fs.rm(root, { recursive: true, force: true })
})

describe('an editor in the chat taking the project over', () => {
  it('moves a call from a starting headless engine to the editor, with no connection error', async () => {
    let release!: () => void
    mocks.gate = new Promise<void>((ok) => (release = ok))
    const calls: string[] = []
    const web = webSession(calls)
    let open = false
    agent.setWebHooks({ session: () => (open ? web : null), alive: (s) => s === web && open, save: async () => {} })

    const pending = agentCall()
    await vi.waitFor(() => expect(mocks.started).toHaveBeenCalledTimes(1))
    // what prepareWeb does: the card takes the project, the headless engine on it stops
    open = true
    await agent.stopSession('filmcraft')
    release()

    const r = await pending
    expect(r.content[0].text).toBe('web')
    expect(calls).toEqual(['sequence_inspect'])
    expect(mocks.calls).not.toHaveBeenCalled()
    expect(errorsReported()).toEqual([])
  })

  it('stops a headless engine that finished starting after the editor opened, and uses the editor', async () => {
    let release!: () => void
    mocks.gate = new Promise<void>((ok) => (release = ok))
    const calls: string[] = []
    const web = webSession(calls)
    let open = false
    agent.setWebHooks({ session: () => (open ? web : null), alive: (s) => s === web && open, save: async () => {} })

    const pending = agentCall()
    await vi.waitFor(() => expect(mocks.started).toHaveBeenCalledTimes(1))
    // the card registered but never saw the engine (it was still starting)
    open = true
    release()

    expect((await pending).content[0].text).toBe('web')
    expect(agent.sessionOf('filmcraft')).toBeNull()
    expect(mocks.calls).not.toHaveBeenCalled()
  })

  it('falls back to the headless engine on the saved file when the editor closes while loading', async () => {
    let close!: (err: Error) => void
    const ready = new Promise<void>((_ok, no) => (close = no))
    ready.catch(() => {})
    const web = webSession([], ready)
    let open = true
    agent.setWebHooks({ session: () => (open ? web : null), alive: (s) => s === web && open, save: async () => {} })

    const pending = agentCall()
    open = false
    close(new Error('closed'))

    expect((await pending).content[0].text).toBe('headless')
    expect(agent.sessionOf('filmcraft')?.mode).toBe('headless')
  })

  it('falls back to the headless engine when the editor failed to load', async () => {
    const ready = Promise.reject(new Error("FilmCraft didn't start in the chat"))
    ready.catch(() => {})
    const web = webSession([], ready)
    let failed = false
    agent.setWebHooks({ session: () => (failed ? null : web), alive: () => !failed, save: async () => {} })
    const pending = agentCall()
    failed = true
    expect((await pending).content[0].text).toBe('headless')
  })

  it('says plainly when the editor is still loading after the wait', async () => {
    agent.setWebReadyMs(30)
    const web = webSession([], new Promise<void>(() => {}))
    agent.setWebHooks({ session: () => web, alive: () => true, save: async () => {} })
    await expect(agentCall()).rejects.toThrow(/still loading/)
    expect(mocks.started).not.toHaveBeenCalled()
  })

  it('clears an earlier connection error once the editor in the chat answers', async () => {
    const web = webSession([])
    let open = false
    agent.setWebHooks({ session: () => (open ? web : null), alive: () => open, save: async () => {} })
    mocks.failStart = "the app's agent connection stopped (exit 1)"
    await expect(agentCall()).rejects.toThrow(/stopped/)
    expect(errorsReported().length).toBe(1)
    mocks.setLive.mockClear()
    open = true
    await agentCall()
    expect(mocks.setLive).toHaveBeenCalledWith('filmcraft', expect.objectContaining({ agent: 'off' }))
    // once cleared, calls don't keep announcing it
    mocks.setLive.mockClear()
    await agentCall()
    expect(mocks.setLive).not.toHaveBeenCalled()
  })

  it('still reports an engine that really fails to start', async () => {
    mocks.failStart = "the app's agent connection couldn't start: spawn test-cli ENOENT"
    agent.setWebHooks({ session: () => null, alive: () => false, save: async () => {} })
    await expect(agentCall()).rejects.toThrow(/couldn't start/)
    expect(errorsReported().length).toBe(1)
    // one try, a real failure isn't retried
    expect(mocks.started).toHaveBeenCalledTimes(1)
  })
})

describe('what the agent is told about the connection', () => {
  const base = { agent: 'off' as const, brandId: null, projectId: null }
  it('names the editor in the chat first', () => {
    expect(connectionFor({ ...base, agent: 'error' }, true, 'b1', 'p1')).toMatch(/editor in the chat/)
  })
  it("doesn't make an old failure sound final", () => {
    expect(connectionFor({ ...base, agent: 'error' }, false, 'b1', 'p1')).toMatch(/next tool call connects again/)
    expect(connectionFor(base, false, 'b1', 'p1')).toMatch(/next tool call connects/)
  })
  it('tells a window on another project apart', () => {
    expect(connectionFor({ agent: 'bridge', brandId: 'b1', projectId: 'p2' }, false, 'b1', 'p1')).toMatch(/another project/)
    expect(connectionFor({ agent: 'bridge', brandId: 'b1', projectId: 'p1' }, false, 'b1', 'p1')).toBe('the full app window')
  })
  it('turns connection failures into what to do next, and leaves the app\'s own answers alone', () => {
    expect(connectError('FilmCraft', "the app's agent connection stopped (exit 1)")).toMatch(/^FilmCraft couldn't connect on this project .*Try the call again/)
    expect(connectError('FilmCraft', 'unknown command `x`')).toBe('FilmCraft: unknown command `x`')
  })
})
