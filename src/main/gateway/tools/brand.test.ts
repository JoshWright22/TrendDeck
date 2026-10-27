import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '../types'

const brandId = '00000000-0000-4000-8000-000000000001'

const state = vi.hoisted(() => ({
  data: null as unknown as { brands: { id: string; name: string; keywords: string[] }[] },
  saved: [] as unknown[]
}))

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../store', () => ({ getData: () => state.data }))
vi.mock('../../workspace', () => ({
  saveDataFromMain: vi.fn(async (next: typeof state.data) => {
    state.data = next
    state.saved.push(next)
    return next
  })
}))
vi.mock('../wait', () => ({ broadcast: vi.fn() }))
vi.mock('../audit', () => ({ appendAudit: vi.fn() }))
vi.mock('../secrets', () => ({ knownSecrets: async () => [] }))
vi.mock('../policy', () => ({ getPolicy: async () => ({ risks: { read: 'auto', edit: 'auto', publish: 'ask', spend: 'ask' }, tools: {}, approvalTimeoutSec: 300 }) }))
vi.mock('../approvals', () => ({ turnAllowed: () => new Set(), requestApproval: vi.fn() }))

const { BRAND_TOOLS, cleanBrandUpdate, describeBrandUpdate } = await import('./brand')

const turn: Turn = { id: 'turn-a', token: '', brandId, threadId: 'chat-a', messageId: null, sharedSiteId: null, startedAt: 1 }

async function call(args: Record<string, unknown>) {
  const { callGatewayTool, registerTools } = await import('../call')
  registerTools(BRAND_TOOLS)
  const r = await callGatewayTool(turn, 'brand_update', args)
  return { isError: r.isError === true, text: (r.content[0] as { text: string }).text }
}

beforeEach(() => {
  vi.resetModules()
  state.data = { brands: [{ id: brandId, name: 'My Brand', keywords: ['old'] }] }
  state.saved = []
})

describe('cleanBrandUpdate', () => {
  it('trims the name and squeezes its spaces', () => {
    expect(cleanBrandUpdate({ name: '  Josh   Wright ' })).toEqual({ name: 'Josh Wright' })
  })

  it('turns down an empty or too long name', () => {
    expect(() => cleanBrandUpdate({ name: '   ' })).toThrow(/can't be empty/)
    expect(() => cleanBrandUpdate({ name: 'x'.repeat(61) })).toThrow(/at most 60 characters/)
    expect(cleanBrandUpdate({ name: 'x'.repeat(60) }).name).toHaveLength(60)
  })

  it('drops empty and duplicate keywords, case aside, keeping the first spelling', () => {
    expect(cleanBrandUpdate({ keywords: [' indie dev ', 'Indie Dev', '', 'game  design', 'indie dev'] })).toEqual({ keywords: ['indie dev', 'game design'] })
  })

  it('caps keywords at 30 after duplicates are gone, and each at 60 characters', () => {
    const many = Array.from({ length: 30 }, (_, i) => `k${i}`)
    expect(cleanBrandUpdate({ keywords: [...many, 'K0', 'k1'] }).keywords).toHaveLength(30)
    expect(() => cleanBrandUpdate({ keywords: [...many, 'one more'] })).toThrow(/at most 30 keywords/)
    expect(() => cleanBrandUpdate({ keywords: ['y'.repeat(61)] })).toThrow(/at most 60 characters/)
  })

  it('an empty keyword list clears them, nothing at all is an error', () => {
    expect(cleanBrandUpdate({ keywords: [] })).toEqual({ keywords: [] })
    expect(() => cleanBrandUpdate({})).toThrow(/pass name, keywords or both/)
  })

  it('describes the change for an approval card', () => {
    expect(describeBrandUpdate({ name: 'My Brand', keywords: [] }, { name: 'Josh Wright', keywords: ['indie dev'] })).toBe('rename the brand from "My Brand" to "Josh Wright" and set its niche keywords to indie dev')
  })
})

describe('brand_update', () => {
  it('is an edit tool that follows the normal approval rules', () => {
    const t = BRAND_TOOLS.find((x) => x.name === 'brand_update')
    expect(t?.risk).toBe('edit')
    expect(t?.alwaysAsk).toBeUndefined()
  })

  it('renames the brand and sets its keywords in one save', async () => {
    const r = await call({ name: 'Josh Wright', keywords: ['indie dev', 'Indie dev', 'game design'] })
    expect(r.isError).toBe(false)
    expect(r.text).toBe('renamed the brand from "My Brand" to "Josh Wright". niche keywords are now: indie dev, game design. its brand files and project folders stay where they are')
    expect(state.saved).toHaveLength(1)
    expect(state.data.brands[0]).toMatchObject({ name: 'Josh Wright', keywords: ['indie dev', 'game design'] })
  })

  it('leaves the keywords alone when only the name is given', async () => {
    await call({ name: 'Josh Wright' })
    expect(state.data.brands[0]).toMatchObject({ name: 'Josh Wright', keywords: ['old'] })
  })

  it('answers a bad name in plain words and saves nothing', async () => {
    const r = await call({ name: 'x'.repeat(80) })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/at most 60 characters/)
    expect(state.saved).toHaveLength(0)
  })
})
