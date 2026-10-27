import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ addCard: vi.fn(async (c: unknown) => c) }))

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0-beta.25', isPackaged: true } }))
vi.mock('../../cards/store', () => ({ addCard: mocks.addCard, newCardId: () => 'card-1' }))
vi.mock('../../craft/state', () => ({ allStatus: () => [] }))
vi.mock('../../store', () => ({ getData: () => ({ settings: {} }) }))
vi.mock('../../updater', () => ({ updateStatus: () => ({ ready: null, lastCheck: null }) }))

const { APP_TOOLS, appStatusReport } = await import('./app')

const app = (id: string, install: unknown, latest: string | null, updateReady: string | null = null): never =>
  ({ app: { id, name: id === 'filmcraft' ? 'FilmCraft' : 'PhotoCraft' }, install, latest, updateReady, running: false }) as never

const base = { version: '0.3.0-beta.25', packaged: true, autoUpdate: true, update: { ready: null, lastCheck: null } as never, craft: [] }

describe('app_status', () => {
  it('says when an update is downloaded and waiting', () => {
    const r = appStatusReport({ ...base, update: { ready: '0.3.0-beta.26', lastCheck: null } } as never) as { trenddeck: { version: string; update: string } }
    expect(r.trenddeck.version).toBe('0.3.0-beta.25')
    expect(r.trenddeck.update).toMatch(/0\.3\.0-beta\.26 is downloaded and waiting.*Update in the title bar/)
  })

  it('tells up to date, a failed check, updates off and a development build apart', () => {
    const at = Date.UTC(2026, 9, 27, 14, 5)
    const say = (p: Record<string, unknown>): string => (appStatusReport({ ...base, ...p } as never) as { trenddeck: { update: string } }).trenddeck.update
    expect(say({ update: { ready: null, lastCheck: { at, result: 'latest' } } })).toBe('up to date, checked 2026-10-27 14:05 UTC')
    expect(say({ update: { ready: null, lastCheck: { at, result: 'error' } } })).toMatch(/last check failed/)
    expect(say({ autoUpdate: false })).toMatch(/automatic updates are off/)
    expect(say({ packaged: false })).toMatch(/development build/)
  })

  it('lists the craft apps with installed and latest versions', () => {
    const r = appStatusReport(({
      ...base,
      craft: [
        app('filmcraft', { kind: 'installed', version: '0.13.0' }, '0.14.0'),
        app('photocraft', { kind: 'not-installed' }, '1.2.0'),
        app('soundcraft', { kind: 'installed', version: '1.0.0' }, '1.0.0', '1.0.1')
      ]
    }) as never) as { craftApps: { app: string; installed: string | false; latest: string | null; state: string }[] }
    expect(r.craftApps[0]).toMatchObject({ app: 'filmcraft', installed: '0.13.0', latest: '0.14.0', state: 'update 0.14.0 available, craft_install gets it' })
    expect(r.craftApps[1]).toMatchObject({ installed: false, state: expect.stringMatching(/not installed/) })
    expect(r.craftApps[2].state).toMatch(/1\.0\.1 downloaded/)
  })

  it('runs from what main knows', async () => {
    const tool = APP_TOOLS.find((t) => t.name === 'app_status')!
    expect(tool.risk).toBe('read')
    expect(await tool.run({} as never, {})).toMatchObject({ trenddeck: { version: '0.3.0-beta.25' }, craftApps: [] })
  })
})

describe('open_settings', () => {
  it('posts a card that opens Settings at the section', async () => {
    const tool = APP_TOOLS.find((t) => t.name === 'open_settings')!
    expect(tool.risk).toBe('read')
    const out = await tool.run({ brandId: 'b1', threadId: 't1', messageId: 'm1' } as never, { section: 'OBS', why: ' Import the OBS password. ' })
    expect(mocks.addCard).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings', section: 'OBS', why: 'Import the OBS password.', brandId: 'b1', threadId: 't1', messageId: 'm1' }))
    expect(String(out)).toMatch(/Settings, OBS/)
  })

  it('refuses a section that does not exist', async () => {
    const tool = APP_TOOLS.find((t) => t.name === 'open_settings')!
    await expect(tool.run({ brandId: 'b1', threadId: null } as never, { section: 'Nope', why: 'x' })).rejects.toThrow(/no Settings section/)
  })
})
