import { ipcRenderer } from 'electron'
import type { EmulatorApi, PhoneInput, PhoneStatus, SetupProgress } from '@shared/emulator'

export const emulatorApi: EmulatorApi = {
  status: () => ipcRenderer.invoke('emulator:status'),
  setup: () => ipcRenderer.invoke('emulator:setup'),
  cancelSetup: () => ipcRenderer.invoke('emulator:cancel-setup'),
  onSetup: (fn) => {
    const listener = (_event: unknown, p: SetupProgress): void => fn(p)
    ipcRenderer.on('emulator:setup', listener)
    return () => ipcRenderer.removeListener('emulator:setup', listener)
  },
  phone: (brandId: string) => ipcRenderer.invoke('emulator:phone', brandId),
  onPhone: (fn) => {
    const listener = (_event: unknown, p: PhoneStatus): void => fn(p)
    ipcRenderer.on('emulator:phone', listener)
    return () => ipcRenderer.removeListener('emulator:phone', listener)
  },
  start: (brandId: string, brandName: string) => ipcRenderer.invoke('emulator:start', brandId, brandName),
  stop: (brandId: string) => ipcRenderer.invoke('emulator:stop', brandId),
  frame: (brandId: string) => ipcRenderer.invoke('emulator:frame', brandId),
  stream: (brandId: string, on: boolean) => ipcRenderer.invoke('emulator:stream', brandId, on),
  onVideo: (fn) => {
    const listener = (_event: unknown, brandId: string, chunk: Uint8Array | null): void => fn(brandId, chunk)
    ipcRenderer.on('emulator:video', listener)
    return () => ipcRenderer.removeListener('emulator:video', listener)
  },
  input: (brandId: string, input: PhoneInput) => ipcRenderer.invoke('emulator:input', brandId, input),
  installApk: (brandId: string) => ipcRenderer.invoke('emulator:install-apk', brandId),
  playStore: (brandId: string, pkg?: string) => ipcRenderer.invoke('emulator:play-store', brandId, pkg),
  wipe: (brandId: string) => ipcRenderer.invoke('emulator:wipe', brandId)
}
