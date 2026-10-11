import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { ID_PATTERN } from '@shared/types'
import type { EmulatorStatus, PhoneInput } from '@shared/emulator'
import { checkVirt, dataDir, findSdk, freeBytes, isComplete } from './sdk'
import { cancelSetup, ESTIMATE_DISK, ESTIMATE_DOWNLOAD, runSetup, setupProgress } from './setup'
import {
  anyRunning,
  grabFrame,
  installApk,
  onPhoneChange,
  openPlayStore,
  phoneStatus,
  sendInput,
  startPhone,
  startStream,
  stopAdbServer,
  stopAll,
  stopPhone,
  stopStream,
  wipePhone
} from './device'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function brandIdOf(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('bad brand id')
  return value
}

async function status(): Promise<EmulatorStatus> {
  const sdk = findSdk()
  const ready = isComplete(sdk)
  return {
    sdk,
    ready,
    virt: await checkVirt(sdk),
    setup: setupProgress(),
    dataDir: dataDir(),
    freeBytes: await freeBytes(dataDir()),
    estimateDownload: ESTIMATE_DOWNLOAD,
    estimateDisk: ESTIMATE_DISK
  }
}

// windows that get video, so a closed window stops its stream
const watched = new Set<number>()

export function setupEmulator(): void {
  onPhoneChange((s) => broadcast('emulator:phone', s))

  ipcMain.handle('emulator:status', () => status())
  ipcMain.handle('emulator:setup', async () => {
    await runSetup((p) => broadcast('emulator:setup', p))
    // the emulator can check acceleration itself now, so ask it fresh
    await checkVirt(findSdk(), true)
  })
  ipcMain.handle('emulator:cancel-setup', () => cancelSetup())
  ipcMain.handle('emulator:phone', (_e, id: unknown) => phoneStatus(brandIdOf(id)))
  ipcMain.handle('emulator:start', (_e, id: unknown, name: unknown) =>
    startPhone(brandIdOf(id), typeof name === 'string' ? name : 'Brand')
  )
  ipcMain.handle('emulator:stop', (_e, id: unknown) => stopPhone(brandIdOf(id)))
  ipcMain.handle('emulator:frame', (_e, id: unknown) => grabFrame(brandIdOf(id)))
  ipcMain.handle('emulator:stream', (event, id: unknown, on: unknown) => {
    const brandId = brandIdOf(id)
    if (on !== true) return stopStream(brandId)
    const wc = event.sender
    const send = (chunk: Uint8Array): void => {
      if (!wc.isDestroyed()) wc.send('emulator:video', brandId, chunk)
    }
    const end = (): void => {
      if (!wc.isDestroyed()) wc.send('emulator:video', brandId, null)
    }
    startStream(brandId, send, end)
    if (!watched.has(wc.id)) {
      watched.add(wc.id)
      wc.once('destroyed', () => stopStream(brandId))
    }
  })
  ipcMain.handle('emulator:input', (_e, id: unknown, input: PhoneInput) => {
    if (!input || typeof input !== 'object') return
    sendInput(brandIdOf(id), input)
  })
  ipcMain.handle('emulator:install-apk', async (event, id: unknown) => {
    const brandId = brandIdOf(id)
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { title: 'Install an APK', filters: [{ name: 'Android app', extensions: ['apk'] }] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return ''
    return installApk(brandId, pick.filePaths[0])
  })
  ipcMain.handle('emulator:play-store', (_e, id: unknown, pkg: unknown) =>
    openPlayStore(brandIdOf(id), typeof pkg === 'string' ? pkg : undefined)
  )
  ipcMain.handle('emulator:wipe', (_e, id: unknown) => wipePhone(brandIdOf(id)))

  // phones get shut down cleanly so their quick boot snapshot is saved
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting || !anyRunning()) return
    event.preventDefault()
    quitting = true
    const cap = new Promise((r) => setTimeout(r, 15000))
    void Promise.race([stopAll(), cap])
      .then(() => stopAdbServer())
      .finally(() => app.quit())
  })
}

// called when a brand is deleted, its phone goes with it
export async function dropBrandPhone(brandId: string): Promise<void> {
  await wipePhone(brandId).catch(() => {})
}
