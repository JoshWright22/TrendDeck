import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  install: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.3.0-beta.12' },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] },
  ipcMain: { handle: (name: string, handler: () => unknown) => mocks.handlers.set(name, handler) },
  net: { fetch: vi.fn() }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {
  on: (name: string, listener: (...args: unknown[]) => void) => mocks.listeners.set(name, listener),
  quitAndInstall: mocks.install
} } }))
vi.mock('original-fs', () => ({ default: { readdirSync: () => [] } }))
vi.mock('./boot-state', () => ({
  bootInfo: () => undefined, newer: () => false, readState: () => null,
  updatesDir: () => '', writeState: vi.fn()
}))
vi.mock('./store', () => ({ loadData: async () => ({ settings: { autoUpdate: false } }) }))
vi.mock('./unpacked-link', () => ({ linkUnpacked: vi.fn(), unlinkUnpacked: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  mocks.handlers.clear()
  mocks.listeners.clear()
  vi.clearAllMocks()
})

describe('explicit desktop update activation', () => {
  it('stages downloaded updates without installing when checking again', async () => {
    vi.useFakeTimers()
    const { setupUpdater } = await import('./updater')
    await setupUpdater()
    mocks.listeners.get('update-downloaded')!({ version: '0.3.0-beta.13' })
    expect(mocks.handlers.get('update:state')!()).toBe('0.3.0-beta.13')
    expect(await mocks.handlers.get('update:check')!()).toBe('downloading')
    expect(mocks.install).not.toHaveBeenCalled()
    mocks.handlers.get('update:install')!()
    expect(mocks.install).toHaveBeenCalledWith(true, true)
  })
})
