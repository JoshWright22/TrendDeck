import { ipcRenderer } from 'electron'
import type { CraftApi, CraftChanged } from '@shared/craft'

// the craft apps' half of the preload, exposed as window.trenddeckCraft. main owns the apps,
// their tokens and their windows, this only asks and listens
export const craftApi: CraftApi = {
  list: () => ipcRenderer.invoke('craft:list'),
  install: (appId) => ipcRenderer.invoke('craft:install', appId),
  uninstall: (appId) => ipcRenderer.invoke('craft:uninstall', appId),
  open: (req) => ipcRenderer.invoke('craft:open', req),
  close: (appId) => ipcRenderer.invoke('craft:close', appId),
  dock: (d) => ipcRenderer.send('craft:dock', d),
  files: (brandId, projectId, appId) => ipcRenderer.invoke('craft:files', brandId, projectId, appId),
  checkUpdates: () => ipcRenderer.invoke('craft:check-updates'),
  onChanged: (fn) => {
    const listener = (_event: unknown, s: CraftChanged): void => fn(s)
    ipcRenderer.on('craft:changed', listener)
    return () => ipcRenderer.removeListener('craft:changed', listener)
  }
}
