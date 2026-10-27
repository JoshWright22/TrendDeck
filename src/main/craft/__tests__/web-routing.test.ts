import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the agent's calls go to an editor open in the chat when there is one on the project, else to a
// headless engine as before. agent.ts only knows the web editors through setWebHooks

const mocks = vi.hoisted(() => ({ headlessCalls: vi.fn(), started: vi.fn() }))

vi.mock('../install', () => ({ installed: async () => ({ cli: 'test-cli', dir: '.', version: '0.13.0' }), craftRoot: () => '.' }))
vi.mock('../launch', () => ({
  cleanEnv: () => ({}), runningApp: () => null,
  onBeforeAppClose: () => {}, onAppStart: () => {}, onAppExit: () => {}
}))
vi.mock('../paths', () => ({ appFiles: async () => [] }))
vi.mock('../state', () => ({ setLive: vi.fn(), changed: vi.fn() }))
vi.mock('../mcp', () => ({ McpClient: class {
  start = async (): Promise<void> => { mocks.started() }
  listTools = async (): Promise<unknown[]> => [{ name: 'command_run' }]
  callTool = (name: string, args: unknown): Promise<unknown> => mocks.headlessCalls(name, args)
  close = (): void => {}
  onExit = (): void => {}
} }))

let root: string
let agent: typeof import('../agent')

beforeEach(async () => {
  vi.resetModules()
  mocks.headlessCalls.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'headless' }] })
  mocks.started.mockReset()
  root = await fs.mkdtemp(join(tmpdir(), 'craft-web-routing-'))
  await fs.writeFile(join(root, 'main.fcproj'), '{}')
  agent = await import('../agent')
})

afterEach(async () => {
  await agent.stopSession('filmcraft', false)
  await fs.rm(root, { recursive: true, force: true })
})

function webSession(calls: string[]): import('../agent').Session {
  return {
    appId: 'filmcraft', mode: 'web', file: join(root, 'main.fcproj'), folder: root, brandId: 'b1', projectId: 'p1',
    client: { callTool: async (name: string) => { calls.push(name); return { content: [{ type: 'text', text: 'web' }] } }, close: () => {} } as never,
    ready: Promise.resolve(), dirty: false, idle: null, cancelAutosave: () => {}
  }
}

describe('routing to the editor in the chat', () => {
  it('uses the web editor on its project and saves a recovery copy before an edit', async () => {
    const calls: string[] = []
    const saves: string[] = []
    const web = webSession(calls)
    let alive = true
    agent.setWebHooks({
      session: (appId, brandId, projectId) => (appId === 'filmcraft' && brandId === 'b1' && projectId === 'p1' && alive ? web : null),
      alive: (s) => s === web && alive,
      save: async (_s, reason) => { saves.push(reason) }
    })
    const s = await agent.sessionFor('filmcraft', 'b1', 'p1', root, async () => join(root, 'main.fcproj'), false)
    expect(s).toBe(web)
    expect(agent.canAutosave(s)).toBe(true)
    const r = await agent.sessionCall(s, true, () => s.client.callTool('command_run', { id: 'timeline.razor', params: {} }), { tool: 'command_run', args: { id: 'timeline.razor' } })
    expect(r.content[0].text).toBe('web')
    expect(calls).toEqual(['command_run'])
    expect(saves).toEqual(['before-edit'])
    expect(mocks.started).not.toHaveBeenCalled()

    // reads don't save
    await agent.sessionCall(s, false, () => s.client.callTool('sequence_inspect', {}))
    expect(saves).toEqual(['before-edit'])

    // the card let go: the old session refuses, the next call goes headless
    alive = false
    await expect(agent.sessionCall(s, false, () => s.client.callTool('sequence_inspect', {}))).rejects.toThrow(/changed/)
    const next = await agent.sessionFor('filmcraft', 'b1', 'p1', root, async () => join(root, 'main.fcproj'), false)
    expect(next.mode).toBe('headless')
    expect(mocks.started).toHaveBeenCalledTimes(1)
  })

  it('leaves other projects to the headless engine', async () => {
    const web = webSession([])
    agent.setWebHooks({ session: (_a, _b, projectId) => (projectId === 'p1' ? web : null), alive: () => true, save: async () => {} })
    const other = await agent.sessionFor('filmcraft', 'b1', 'p2', root, async () => join(root, 'main.fcproj'), false)
    expect(other.mode).toBe('headless')
  })

  it('passes on a refusal from an editor that has unsaved changes it can not save itself', async () => {
    agent.setWebHooks({ session: () => { throw new Error('PhotoCraft in the chat may have changes that aren\'t saved') }, alive: () => false, save: async () => {} })
    await expect(agent.sessionFor('photocraft', 'b1', 'p1', root, async () => null, false)).rejects.toThrow(/aren't saved/)
  })

  it('blocks switching documents inside the web session', async () => {
    const web = webSession([])
    agent.setWebHooks({ session: () => web, alive: () => true, save: async () => {} })
    const s = await agent.sessionFor('filmcraft', 'b1', 'p1', root, async () => null, false)
    await expect(agent.sessionCall(s, true, async () => ({ content: [] }), { tool: 'command_run', args: { id: 'file.open', params: { path: 'x.fcproj' } } })).rejects.toThrow(/Changing documents/)
  })
})
