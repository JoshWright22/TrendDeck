import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

let state: typeof import('../state')

beforeEach(async () => {
  vi.resetModules()
  state = await import('../state')
})

describe('live autosave status', () => {
  it('is optional until a running editor has status and preserves the existing status fields', () => {
    expect(state.status('filmcraft').autosave).toBeUndefined()
    state.setLive('filmcraft', { running: true, brandId: 'brand', projectId: 'project', agent: 'bridge' }, false)
    const autosave = { state: 'saved' as const, savedAt: 123, note: 'Saved with a recoverable snapshot.' }
    state.setLive('filmcraft', { autosave }, false)
    expect(state.status('filmcraft')).toMatchObject({ running: true, brandId: 'brand', projectId: 'project', agent: 'bridge', autosave })
    expect(state.allStatus().find((entry) => entry.app.id === 'filmcraft')?.autosave).toEqual(autosave)
    state.setLive('filmcraft', { autosave: undefined }, false)
    expect(state.status('filmcraft').autosave).toBeUndefined()
  })

  it('never serializes a stale live save for headless sessions or an exited editor', () => {
    const autosave = { state: 'saved' as const, savedAt: 123, note: 'Saved with a recoverable snapshot.' }
    state.setLive('filmcraft', { running: true, agent: 'headless', autosave }, false)
    expect(state.status('filmcraft').autosave).toBeUndefined()
    state.setLive('filmcraft', { running: false, agent: 'bridge', autosave }, false)
    expect(state.status('filmcraft').autosave).toBeUndefined()
    expect(JSON.parse(JSON.stringify(state.status('filmcraft')))).not.toHaveProperty('autosave')
  })
})
