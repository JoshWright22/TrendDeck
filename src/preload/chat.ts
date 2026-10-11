import { ipcRenderer } from 'electron'
import type { ChatApi, ChatEvent } from '@shared/chat'

// the chat's half of the preload, exposed as window.trenddeckChat
export const chatApi: ChatApi = {
  listAgents: (rescan) => ipcRenderer.invoke('chat:agents', rescan === true),
  getAgentConfig: () => ipcRenderer.invoke('chat:config'),
  saveCustomAgent: (agent) => ipcRenderer.invoke('chat:save-agent', agent),
  removeCustomAgent: (id) => ipcRenderer.invoke('chat:remove-agent', id),
  setDefaultAgent: (id) => ipcRenderer.invoke('chat:default-agent', id),
  listThreads: (brandId) => ipcRenderer.invoke('chat:threads', brandId),
  getThread: (brandId, threadId) => ipcRenderer.invoke('chat:thread', brandId, threadId),
  deleteThread: (brandId, threadId) => ipcRenderer.invoke('chat:delete', brandId, threadId),
  send: (brandId, threadId, text, agentId) => ipcRenderer.invoke('chat:send', brandId, threadId, text, agentId),
  stop: (brandId, threadId) => ipcRenderer.invoke('chat:stop', brandId, threadId),
  onEvent: (fn) => {
    const listener = (_event: unknown, ev: ChatEvent): void => fn(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  }
}
