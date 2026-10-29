import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: {}, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} } }))

describe('obsRequestAllowed', () => {
  it('lets OBS reads and settings through, keeps the stream key and start or stop out', async () => {
    const { obsRequestAllowed, obsReadOnly } = await import('./service')
    for (const r of ['GetStats', 'GetVideoSettings', 'SetSceneItemEnabled', 'SetVideoSettings', 'SetProfileParameter']) expect(obsRequestAllowed(r), r).toBeNull()
    for (const r of ['GetStreamServiceSettings', 'SetStreamServiceSettings', 'StartRecord', 'StopStream', 'ToggleRecord', 'Shutdown', 'SetRecordDirectory', 'get stats']) expect(obsRequestAllowed(r), r).not.toBeNull()
    expect(obsReadOnly('GetStats')).toBe(true)
    expect(obsReadOnly('SetVideoSettings')).toBe(false)
  })
})
