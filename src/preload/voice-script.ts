import { ipcRenderer } from 'electron'
import type { BrandMemoryApi } from '@shared/brand-memory'
import type { ScriptsApi, ScriptsChanged } from '@shared/script'
import type { TakesApi } from '@shared/take'

// scripts, takes and brand memory, exposed as window.trenddeckScripts, trenddeckTakes and
// trenddeckBrandMemory

export const scriptsApi: ScriptsApi = {
  get: (b, p, f) => ipcRenderer.invoke('scripts:get', b, p, f),
  change: (b, p, f, c) => ipcRenderer.invoke('scripts:change', b, p, f, c),
  setStatus: (b, p, f, s) => ipcRenderer.invoke('scripts:status', b, p, f, s),
  saveDump: (b, p, t, audio) => ipcRenderer.invoke('scripts:save-dump', b, p, t, audio),
  addSpeech: (b, t) => ipcRenderer.invoke('scripts:speech', b, t),
  show: (b, p, thread) => ipcRenderer.invoke('scripts:show', b, p, thread),
  onChanged: (fn) => {
    const listener = (_e: unknown, c: ScriptsChanged): void => fn(c)
    ipcRenderer.on('scripts:changed', listener)
    return () => ipcRenderer.removeListener('scripts:changed', listener)
  }
}

export const takesApi: TakesApi = {
  fromFile: (b, thread, p, file) => ipcRenderer.invoke('takes:from-file', b, thread, p, file),
  saveRecording: (b, thread, p, name, mime, bytes) => ipcRenderer.invoke('takes:save-recording', b, thread, p, name, mime, bytes),
  audio: (b, id) => ipcRenderer.invoke('takes:audio', b, id),
  setTranscript: (b, id, t, err) => ipcRenderer.invoke('takes:set-transcript', b, id, t, err),
  rediff: (b, id) => ipcRenderer.invoke('takes:rediff', b, id)
}

export const brandMemoryApi: BrandMemoryApi = {
  state: (b) => ipcRenderer.invoke('brand-memory:state', b),
  wrapUp: (b) => ipcRenderer.invoke('brand-memory:wrap-up', b),
  keepRule: (b, id, text) => ipcRenderer.invoke('brand-memory:keep-rule', b, id, text),
  dropRule: (b, id) => ipcRenderer.invoke('brand-memory:drop-rule', b, id),
  keepFile: (b, id, content) => ipcRenderer.invoke('brand-memory:keep-file', b, id, content),
  dropFile: (b, id) => ipcRenderer.invoke('brand-memory:drop-file', b, id),
  readFile: (b, f) => ipcRenderer.invoke('brand-memory:read-file', b, f),
  intakePrompt: () => ipcRenderer.invoke('brand-memory:intake-prompt'),
  onChanged: (fn) => {
    const listener = (_e: unknown, brandId: string): void => fn(brandId)
    ipcRenderer.on('brand-memory:changed', listener)
    return () => ipcRenderer.removeListener('brand-memory:changed', listener)
  }
}
