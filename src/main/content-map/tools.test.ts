import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '../gateway/types'

const brandId = '00000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  // an approval nobody answers, like a card the creator hasn't seen yet
  requestApproval: vi.fn(() => new Promise(() => {})),
  setPillars: vi.fn(async (_b: string, list: { label: string }[]) => list.map((p, i) => ({ id: `p${i}`, label: p.label, keywords: [], why: '', createdAt: 1 }))),
  changed: vi.fn(),
  mapView: vi.fn(async () => ({ rows: [], pillars: [] }) as unknown),
  policy: { risks: { read: 'auto', edit: 'auto', publish: 'ask', spend: 'ask' }, tools: {} as Record<string, string>, approvalTimeoutSec: 300 }
}))

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../store', () => ({ getData: () => ({ brands: [{ id: brandId, name: 'Josh Wright', keywords: [], projects: [] }] }) }))
vi.mock('../workspace', () => ({ saveDataFromMain: vi.fn() }))
vi.mock('../cards/store', () => ({ addCard: vi.fn(), newCardId: () => 'card-1' }))
vi.mock('./service', () => ({ changed: mocks.changed, findVideo: vi.fn(), mapView: mocks.mapView, setPillars: mocks.setPillars, sync: vi.fn(), videoDetail: vi.fn() }))
vi.mock('./store', () => ({ loadMap: vi.fn() }))
vi.mock('../gateway/wait', () => ({ broadcast: vi.fn() }))
vi.mock('../gateway/audit', () => ({ appendAudit: vi.fn() }))
vi.mock('../gateway/secrets', () => ({ knownSecrets: async () => [] }))
vi.mock('../gateway/policy', () => ({ getPolicy: async () => mocks.policy }))
vi.mock('../gateway/approvals', () => ({ turnAllowed: () => new Set(), requestApproval: mocks.requestApproval }))

const turn: Turn = { id: 'turn-a', token: '', brandId, threadId: 'chat-a', messageId: 'message-a', sharedSiteId: null, startedAt: 1 }
const PILLARS = {
  pillars: [
    { label: 'Build logs', keywords: ['build', 'devlog'] },
    { label: 'Tool reviews', keywords: ['review'] },
    { label: 'Behind the scenes', keywords: ['bts', 'studio'] }
  ],
  mode: 'replace'
}

async function call(args: Record<string, unknown>) {
  const { callGatewayTool, registerTools } = await import('../gateway/call')
  const { CONTENT_MAP_TOOLS } = await import('./tools')
  registerTools(CONTENT_MAP_TOOLS)
  // an agent gives up on a tool call that doesn't come back, this is that limit made short
  return Promise.race([
    callGatewayTool(turn, 'pillar_propose', args),
    new Promise<'no answer'>((ok) => setTimeout(() => ok('no answer'), 1000))
  ])
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.policy.risks.edit = 'auto'
  mocks.mapView.mockImplementation(async () => ({ rows: [], pillars: [] }))
})

describe('pillar_propose', () => {
  it('saves the pillars right away instead of waiting on an approval', async () => {
    const r = await call(PILLARS)
    expect(r).not.toBe('no answer')
    if (r === 'no answer') return
    expect(mocks.requestApproval).not.toHaveBeenCalled()
    expect(r.isError).not.toBe(true)
    expect(mocks.setPillars).toHaveBeenCalledWith(brandId, expect.arrayContaining([expect.objectContaining({ label: 'Build logs', keywords: ['build', 'devlog'], why: '' })]), 'replace')
    expect(mocks.changed).toHaveBeenCalledWith(brandId)
    const text = (r.content[0] as { text: string }).text
    expect(text).toMatch(/^saved\. the brand's pillars are now: Build logs, Tool reviews, Behind the scenes\./)
    expect(text).toMatch(/no past videos are mapped yet/)
  })

  it('says how many videos went into each pillar when the map has videos', async () => {
    mocks.mapView.mockImplementation(async () => ({ rows: [{}], pillars: [{ label: 'Build logs', count: 4 }, { label: 'No pillar', count: 2 }] }))
    const r = await call(PILLARS)
    if (r === 'no answer') throw new Error('no answer')
    expect((r.content[0] as { text: string }).text).toMatch(/videos per pillar: Build logs 4, No pillar 2/)
  })

  it('still follows a brand that set edits to ask', async () => {
    mocks.policy.risks.edit = 'ask'
    mocks.requestApproval.mockImplementationOnce(async () => ({ decision: 'approved', note: '', scope: 'once' }))
    const r = await call(PILLARS)
    if (r === 'no answer') throw new Error('no answer')
    expect(mocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ tool: 'pillar_propose', alwaysAsk: false }), 300)
    expect(r.isError).not.toBe(true)
  })
})
