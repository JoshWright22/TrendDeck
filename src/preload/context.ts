import { ipcRenderer } from 'electron'
import type { ContextApi } from '@shared/context'

// the agent context half of the preload, exposed as window.trenddeckContext. main reads the
// folders and keeps the rules, this only asks and listens
export const contextApi: ContextApi = {
  get: (brandId) => ipcRenderer.invoke('context:get', brandId),
  pickFolder: (brandId) => ipcRenderer.invoke('context:pick-folder', brandId),
  clearFolder: (brandId) => ipcRenderer.invoke('context:clear-folder', brandId),
  reindex: (brandId) => ipcRenderer.invoke('context:reindex', brandId),
  addRule: (brandId, text) => ipcRenderer.invoke('context:rule-add', brandId, text),
  editRule: (brandId, id, text) => ipcRenderer.invoke('context:rule-edit', brandId, id, text),
  removeRule: (brandId, id) => ipcRenderer.invoke('context:rule-remove', brandId, id),
  onChanged: (fn) => {
    const listener = (_event: unknown, brandId: string): void => fn(brandId)
    ipcRenderer.on('context:changed', listener)
    return () => ipcRenderer.removeListener('context:changed', listener)
  }
}
