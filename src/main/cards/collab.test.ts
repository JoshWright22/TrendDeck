import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'td-collab-'))
const edited = vi.fn()
const saveAsset = vi.fn()

vi.mock('../craft/agent', () => ({ cachedTools: () => [] }))
vi.mock('../craft/catalog', () => ({ spec: () => ({ agent: false }) }))
vi.mock('../craft/launch', () => ({ runningApp: () => null }))
vi.mock('../craft/paths', () => ({ knownFolder: () => 'C:/projects/ep1' }))
vi.mock('../craft/tools', () => ({ appCall: vi.fn(), resultJson: vi.fn() }))
vi.mock('../craft/web', () => ({ webEdited: (...a: unknown[]) => edited(...a), webStill: async () => 'data:image/png;base64,' }))
vi.mock('../visuals/store', () => ({ decodeDataUrl: () => Buffer.from(''), saveAsset: (...a: unknown[]) => saveAsset(...a) }))
vi.mock('../visuals/paths', () => ({ visualsRoot: () => dir }))
vi.mock('../mcp/turns', () => ({ onTurnClosed: vi.fn() }))
vi.mock('./embed', () => ({ currentFile: async () => null, liveOn: () => false, onCommentMarkers: vi.fn(), setOnEmbedded: vi.fn() }))
vi.mock('./store', () => ({
  cardsDir: () => dir,
  listCards: async () => [{ id: 'c1', type: 'craft', appId: 'photocraft', appName: 'PhotoCraft', projectId: 'p1', file: 'Ep 1.pcraft' }]
}))

const { takeLook, turnNotes } = await import('./collab')

describe('the agent hears about images the user edited', () => {
  beforeEach(() => {
    edited.mockReset()
    saveAsset.mockReset()
    saveAsset.mockResolvedValue({ id: 'v1' })
  })

  it('points the agent to a picture of an image edited since its last reply', async () => {
    await takeLook('b1', 't1', 'photocraft', 'p1')
    edited.mockReturnValue({ cardId: 'c1', editedAt: Date.now() + 1000 })
    const notes = await turnNotes('b1', 't1')
    expect(notes).toContain('visual v1')
    expect(notes).toContain('visual_get only if you need')
    expect(saveAsset).toHaveBeenCalledTimes(1)
  })

  it('says nothing and saves no picture when the user did not touch it', async () => {
    edited.mockReturnValue({ cardId: 'c1', editedAt: 1 })
    await takeLook('b2', 't2', 'photocraft', 'p1')
    expect(await turnNotes('b2', 't2')).toBe('')
    edited.mockReturnValue(null)
    expect(await turnNotes('b2', 't2')).toBe('')
    expect(saveAsset).not.toHaveBeenCalled()
  })
})
