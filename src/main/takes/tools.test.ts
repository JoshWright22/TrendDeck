import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TakeCard } from '@shared/cards'
import type { Turn } from '../gateway/types'

const state = vi.hoisted(() => ({ directory: '', approved: false }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory }, ipcMain: { handle: vi.fn() } }))
vi.mock('../gateway/wait', () => ({ broadcast: vi.fn() }))
vi.mock('../workspace', () => ({ saveDataFromMain: vi.fn() }))
vi.mock('../store', () => ({ getData: () => ({ brands: [{ id: '00000000-0000-4000-8000-000000000001', projects: [{ id: 'project-a', name: 'Video', threadIds: ['chat-a'] }] }] }) }))
vi.mock('../brand-memory', () => ({ addSpeech: vi.fn(), logFriction: vi.fn(), readCadenceProfile: vi.fn() }))
vi.mock('../craft/paths', () => ({ findProject: vi.fn(), knownFolder: vi.fn(), projectFolder: vi.fn() }))
vi.mock('../scripts', () => ({ scriptLines: vi.fn() }))
vi.mock('../qc/ffmpeg', () => ({ ffmpegPaths: vi.fn(), run: vi.fn() }))
vi.mock('../gateway/audit', () => ({ appendAudit: vi.fn() }))
vi.mock('../gateway/secrets', () => ({ knownSecrets: async () => [] }))
vi.mock('../gateway/policy', () => ({ getPolicy: async () => ({ risks: { read: 'auto', edit: 'auto', publish: 'auto' }, tools: {}, approvalTimeoutSec: 10 }) }))
vi.mock('../gateway/approvals', () => ({
  turnAllowed: () => new Set(),
  requestApproval: vi.fn(async () => ({ decision: state.approved ? 'approved' : 'denied', note: '' }))
}))
vi.mock('../obs/service', () => ({
  isStreaming: vi.fn(async () => false), obsScenes: vi.fn(), obsStatus: vi.fn(async () => ({ connected: false })),
  recentTakes: vi.fn(async () => []), screenshot: vi.fn(), setInputMute: vi.fn(), setupRecording: vi.fn(),
  startRecording: vi.fn(async () => 'started'), startStream: vi.fn(), stopRecording: vi.fn(), stopStream: vi.fn(), switchScene: vi.fn()
}))

const brandId = '00000000-0000-4000-8000-000000000001'
const otherBrandId = '00000000-0000-4000-8000-000000000002'
const turn: Turn = { id: 'turn-a', token: '', brandId, threadId: 'chat-a', messageId: 'message-a', sharedSiteId: null, startedAt: 1 }

function take(overrides: Partial<TakeCard> = {}): TakeCard {
  return {
    id: 'take-a', brandId, threadId: 'chat-a', messageId: null, at: 1, updatedAt: 1, type: 'take',
    projectId: 'project-a', media: { projectId: 'project-a', file: 'footage/clip.webm', kind: 'video' }, source: 'composer',
    title: 'Clip', state: 'ready', error: '', transcript: { text: 'Hello', words: [{ text: 'Hello', start: 0.5, end: 1 }], duration: 1, engine: 'local', model: '' },
    feedback: null, diff: null, ...overrides
  }
}

async function call(name: string, args: Record<string, unknown> = {}, activeTurn = turn) {
  const { callGatewayTool } = await import('../gateway/call')
  return callGatewayTool(activeTurn, name, args)
}

async function read(name: string, args: Record<string, unknown> = {}) {
  const result = await call(name, args)
  expect(result.isError).not.toBe(true)
  const content = result.content[0]
  if (content.type !== 'text') throw new Error('Expected text result')
  return JSON.parse(content.text)
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  state.approved = false
  state.directory = await fs.mkdtemp(join(tmpdir(), 'trenddeck-take-tools-'))
  const { registerTools } = await import('../gateway/call')
  const { TAKE_TOOLS } = await import('./index')
  const { OBS_TOOLS } = await import('../obs/tools')
  registerTools([...OBS_TOOLS, ...TAKE_TOOLS])
})

afterEach(async () => {
  await fs.rm(state.directory, { recursive: true, force: true })
})

describe('OBS and take gateway discovery', () => {
  it.each(['claude', 'codex', 'opencode', 'generic'] as const)('attaches %s to the shared gateway without a per-tool allowlist', async (provider) => {
    const { attachFor } = await import('../mcp/attach')
    const url = 'http://127.0.0.1:12345/mcp'
    const attachment = await attachFor(provider, turn, url)
    try {
      expect(attachment.env.TRENDDECK_MCP_URL).toBe(url)
      const config = [attachment.args.join(' '), ...await Promise.all(attachment.files.map((file) => fs.readFile(file, 'utf8')))].join('\n')
      expect(config).toContain('trenddeck')
      expect(config).not.toContain('take_get')
      expect(config).not.toContain('obs_status')
    } finally {
      await attachment.cleanup()
    }
  })

  it('shows OBS before a recording exists without connecting or capturing', async () => {
    expect((await call('obs_show')).isError).not.toBe(true)
    const { listCards } = await import('../cards/store')
    expect(await listCards(brandId, 'chat-a')).toEqual([expect.objectContaining({ type: 'obs', projectId: 'project-a', threadId: 'chat-a', messageId: 'message-a' })])
    const service = await import('../obs/service')
    expect(service.obsStatus).not.toHaveBeenCalled()
    expect(service.startRecording).not.toHaveBeenCalled()
    expect(service.screenshot).not.toHaveBeenCalled()
  })

  it.each(['obs_setup_recording', 'obs_start_recording', 'obs_stop_recording', 'obs_stream_start', 'obs_stream_stop'])('requires approval for %s even with auto policy', async (name) => {
    expect((await call(name)).isError).toBe(true)
    const { requestApproval } = await import('../gateway/approvals')
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ tool: name, alwaysAsk: true }), 10)
    const service = await import('../obs/service')
    for (const operation of [service.setupRecording, service.startRecording, service.stopRecording, service.startStream, service.stopStream]) expect(operation).not.toHaveBeenCalled()
  })

  it('starts recording only after approval with the active brand, project and chat', async () => {
    state.approved = true
    expect((await call('obs_start_recording')).isError).not.toBe(true)
    const { startRecording } = await import('../obs/service')
    expect(startRecording).toHaveBeenCalledWith(brandId, 'project-a', 'chat-a')
    const { requestApproval } = await import('../gateway/approvals')
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('may send audio to a remote transcription service') }), 10)
  })

  it('requires explicit permission before creating and transcribing a new take', async () => {
    expect((await call('take_show', { file: 'footage/clip.webm' })).isError).toBe(true)
    const { requestApproval } = await import('../gateway/approvals')
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ tool: 'take_show', alwaysAsk: true, summary: expect.stringContaining('remote transcription service') }), 10)
    const { listCards } = await import('../cards/store')
    expect(await listCards(brandId, 'chat-a')).toEqual([])
    const { projectFolder } = await import('../craft/paths')
    expect(projectFolder).not.toHaveBeenCalled()
  })

  it('advertises every scoped tool with its schema through the common MCP list', async () => {
    const { mcpToolList } = await import('../gateway/call')
    const { OBS_TOOLS } = await import('../obs/tools')
    const { TAKE_TOOLS } = await import('./index')
    for (const tool of [...OBS_TOOLS, ...TAKE_TOOLS]) {
      expect(mcpToolList(turn)).toContainEqual(expect.objectContaining({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    }
  })
})

describe('saved take discovery and reads', () => {
  it('lists only this brand and chat, newest first, without transcript or audio', async () => {
    const { addCard } = await import('../cards/store')
    await addCard(take())
    await addCard(take({ id: 'newer', at: 3, state: 'transcribing', transcript: null }))
    await addCard(take({ id: 'other-chat', threadId: 'chat-b' }))
    await addCard(take({ id: 'other-brand', brandId: otherBrandId }))
    await call('obs_show')
    const result = await read('take_list')
    expect(result.map((card: { cardId: string }) => card.cardId)).toEqual(['newer', 'take-a'])
    expect(result[0]).toMatchObject({ state: 'transcribing', file: 'footage/clip.webm', projectId: 'project-a' })
    expect(JSON.stringify(result)).not.toContain('Hello')
    expect(result[0]).not.toHaveProperty('transcript')
  })

  it('filters by project, limits results and rejects a foreign project', async () => {
    const { addCard } = await import('../cards/store')
    await addCard(take({ id: 'other-project', projectId: 'project-b', at: 9 }))
    await addCard(take())
    await addCard(take({ id: 'newer', at: 2 }))
    expect(await read('take_list', { projectId: 'project-a', limit: 1 })).toEqual([expect.objectContaining({ cardId: 'newer' })])
    expect((await call('take_list', { projectId: 'foreign-project' })).isError).toBe(true)
    for (const limit of [0, 101, 1.5]) expect((await call('take_list', { limit })).isError).toBe(true)
  })

  it('handles no cards and a missing chat without scanning recordings', async () => {
    expect(await read('take_list')).toEqual([])
    expect((await call('take_list', {}, { ...turn, threadId: null })).isError).toBe(true)
    const { recentTakes } = await import('../obs/service')
    expect(recentTakes).not.toHaveBeenCalled()
  })

  it('reads a ready take through the gateway without extracting audio', async () => {
    const { addCard } = await import('../cards/store')
    await addCard(take())
    expect(await read('take_get', { cardId: 'take-a' })).toMatchObject({ cardId: 'take-a', state: 'ready', transcript: '0.50 Hello', script: 'the project has no script to compare with' })
    const { run } = await import('../qc/ffmpeg')
    expect(run).not.toHaveBeenCalled()
  })

  it('returns real script comparison, cadence feedback and pickup details', async () => {
    const { addCard } = await import('../cards/store')
    const card = take({
      feedback: { duration: 1, words: 1, wpm: 60, usualWpm: null, fillers: [], longPauses: [], notes: [] },
      diff: {
        scriptFile: 'scripts/script.md',
        lines: [{ lineId: 'line-a', text: 'Hello again', status: 'flubbed', coverage: 0.5, from: 0.5, to: 1, said: 'Hello' }],
        pickups: [{ lineId: 'line-a', text: 'Hello again', reason: 'Missing a word', at: 0.5 }]
      }
    })
    await addCard(card)
    expect(await read('take_get', { cardId: card.id })).toMatchObject({ feedback: card.feedback, script: { file: 'scripts/script.md', pickups: card.diff?.pickups, lines: [{ id: 'line-a', status: 'flubbed', from: 0.5, to: 1, said: 'Hello' }] } })
  })

  it('defaults to twenty cards and honors the bounded explicit limit', async () => {
    const { addCard } = await import('../cards/store')
    for (let index = 0; index < 22; index++) await addCard(take({ id: `take-${index}`, at: index }))
    expect(await read('take_list')).toHaveLength(20)
    expect(await read('take_list', { limit: 100 })).toHaveLength(22)
  })

  it.each(['transcribing', 'failed'] as const)('keeps %s take identity and file available without claiming analysis', async (state) => {
    const { addCard } = await import('../cards/store')
    await addCard(take({ state, transcript: null, error: state === 'failed' ? 'Transcription unavailable' : '' }))
    expect(await read('take_get', { cardId: 'take-a' })).toMatchObject({ cardId: 'take-a', state, transcript: null, file: 'footage/clip.webm' })
  })

  it('rejects missing, non-take and other-brand card ids', async () => {
    const { addCard, listCards } = await import('../cards/store')
    await addCard(take({ id: 'foreign', brandId: otherBrandId }))
    await call('obs_show')
    const [obs] = await listCards(brandId, 'chat-a')
    for (const cardId of ['missing', 'foreign', obs.id]) expect((await call('take_get', { cardId })).isError).toBe(true)
  })
})
