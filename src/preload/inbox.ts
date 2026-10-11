import { ipcRenderer } from 'electron'
import type { BrandInbox, InboxApi } from '@shared/inbox'

export const inboxApi: InboxApi = {
  load: (brandId) => ipcRenderer.invoke('inbox:load', brandId),
  onUpdate: (fn) => {
    const listener = (_event: unknown, brandId: string, inbox: BrandInbox): void => fn(brandId, inbox)
    ipcRenderer.on('inbox:update', listener)
    return () => ipcRenderer.removeListener('inbox:update', listener)
  },
  checkHealth: (brandId) => ipcRenderer.invoke('inbox:health', brandId),
  refresh: (brandId) => ipcRenderer.invoke('inbox:refresh', brandId),
  markRead: (brandId, ids, read) => ipcRenderer.invoke('inbox:read', brandId, ids, read),
  setBlocked: (brandId, blocked) => ipcRenderer.invoke('inbox:blocked', brandId, blocked),
  setKeywords: (brandId, keywords) => ipcRenderer.invoke('inbox:keywords', brandId, keywords),
  reply: (brandId, id, text) => ipcRenderer.invoke('inbox:reply', brandId, id, text),
  openBlock: (brandId, id) => ipcRenderer.invoke('inbox:block-on-site', brandId, id)
}
