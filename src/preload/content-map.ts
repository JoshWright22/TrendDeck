import { ipcRenderer } from 'electron'
import type { ContentMapApi } from '@shared/content-map'

// the content map, exposed as window.trenddeckContentMap. there's no call that returns a token
// or the OAuth client secret, main keeps those to itself

export const contentMapApi: ContentMapApi = {
  view: (b) => ipcRenderer.invoke('content-map:view', b),
  detail: (b, id) => ipcRenderer.invoke('content-map:detail', b, id),
  sync: (b) => ipcRenderer.invoke('content-map:sync', b),
  setClient: (id, secret) => ipcRenderer.invoke('content-map:set-client', id, secret),
  clearClient: () => ipcRenderer.invoke('content-map:clear-client'),
  connect: (b) => ipcRenderer.invoke('content-map:connect', b),
  disconnect: (b) => ipcRenderer.invoke('content-map:disconnect', b),
  setPublicChannel: (b, ch) => ipcRenderer.invoke('content-map:public-channel', b, ch),
  importCsv: (b) => ipcRenderer.invoke('content-map:import-csv', b),
  removePillar: (b, id) => ipcRenderer.invoke('content-map:remove-pillar', b, id),
  setProject: (b, v, p) => ipcRenderer.invoke('content-map:set-project', b, v, p),
  keepLearning: (b, c, id, t) => ipcRenderer.invoke('content-map:keep-learning', b, c, id, t),
  dropLearning: (b, c, id) => ipcRenderer.invoke('content-map:drop-learning', b, c, id),
  addLearning: (b, c, t) => ipcRenderer.invoke('content-map:add-learning', b, c, t),
  onChanged: (fn) => {
    const listener = (_e: unknown, brandId: string): void => fn(brandId)
    ipcRenderer.on('content-map:changed', listener)
    return () => ipcRenderer.removeListener('content-map:changed', listener)
  }
}
