import { ipcRenderer } from 'electron'
import type { PostingApi, PostingState } from '@shared/posting'

export const postingApi: PostingApi = {
  get: () => ipcRenderer.invoke('posting:get'),
  onOpenSite: (fn) => {
    const listener = (_event: unknown, to: { brandId: string; siteId: string; url: string }): void => fn(to)
    ipcRenderer.on('posting:open-site', listener)
    return () => ipcRenderer.removeListener('posting:open-site', listener)
  },
  onUpdate: (fn) => {
    const listener = (_event: unknown, state: PostingState): void => fn(state)
    ipcRenderer.on('posting:update', listener)
    return () => ipcRenderer.removeListener('posting:update', listener)
  },
  save: (posts) => ipcRenderer.invoke('posting:save', posts),
  remove: (id) => ipcRenderer.invoke('posting:remove', id),
  run: (id) => ipcRenderer.invoke('posting:run', id),
  markPosted: (id) => ipcRenderer.invoke('posting:mark-posted', id),
  focus: (id) => ipcRenderer.invoke('posting:focus', id),
  setBrand: (brandId, patch) => ipcRenderer.invoke('posting:set-brand', brandId, patch),
  setKeys: (brandId, platform, values) => ipcRenderer.invoke('posting:set-keys', brandId, platform, values),
  connectYouTube: (brandId) => ipcRenderer.invoke('posting:connect-youtube', brandId),
  check: (brandId, platform, subreddit) => ipcRenderer.invoke('posting:check', brandId, platform, subreddit),
  clearLog: (brandId) => ipcRenderer.invoke('posting:clear-log', brandId)
}
