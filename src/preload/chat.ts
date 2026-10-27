import { ipcRenderer } from 'electron'
import type { ChatApi, ChatEvent } from '@shared/chat'
import type { ProviderChatApi, ProviderChatEvent } from '@shared/providers'

// the chat's half of the preload, exposed as window.trenddeckChat
export const chatApi: ChatApi & ProviderChatApi = {
  listAgents: (rescan) => ipcRenderer.invoke('chat:agents', rescan === true),
  getAgentConfig: () => ipcRenderer.invoke('chat:config'),
  saveCustomAgent: (agent) => ipcRenderer.invoke('chat:save-agent', agent),
  removeCustomAgent: (id) => ipcRenderer.invoke('chat:remove-agent', id),
  setDefaultAgent: (id) => ipcRenderer.invoke('chat:default-agent', id),
  setRank: (rank, autoOff) => ipcRenderer.invoke('chat:rank', rank, autoOff),
  saveAccount: (account) => ipcRenderer.invoke('chat:save-account', account),
  removeAccount: (id) => ipcRenderer.invoke('chat:remove-account', id),
  accountFolders: (base) => ipcRenderer.invoke('chat:account-folders', base),
  pickFolder: () => ipcRenderer.invoke('chat:pick-folder'),
  signIn: (agentId) => ipcRenderer.invoke('chat:sign-in', agentId),
  listThreads: (brandId) => ipcRenderer.invoke('chat:threads', brandId),
  getThread: (brandId, threadId) => ipcRenderer.invoke('chat:thread', brandId, threadId),
  deleteThread: (brandId, threadId) => ipcRenderer.invoke('chat:delete', brandId, threadId),
  send: (brandId, threadId, text, agentId, opts) =>
    ipcRenderer.invoke('chat:send', brandId, threadId, text, agentId, opts ?? {}),
  stop: (brandId, threadId) => ipcRenderer.invoke('chat:stop', brandId, threadId),
  retry: (brandId, threadId, agentId) => ipcRenderer.invoke('chat:retry', brandId, threadId, agentId),
  editAndResend: (brandId, threadId, messageId, text, agentId) =>
    ipcRenderer.invoke('chat:edit', brandId, threadId, messageId, text, agentId),
  renameThread: (brandId, threadId, title) => ipcRenderer.invoke('chat:rename', brandId, threadId, title),
  archiveThread: (brandId, threadId, archived) => ipcRenderer.invoke('chat:archive', brandId, threadId, archived),
  searchThreads: (brandId, query) => ipcRenderer.invoke('chat:search', brandId, query),
  setModel: (brandId, threadId, agentId, model) => ipcRenderer.invoke('chat:model', brandId, threadId, agentId, model),
  setEffort: (brandId, threadId, agentId, effort) => ipcRenderer.invoke('chat:effort', brandId, threadId, agentId, effort),
  listModels: (agentId) => ipcRenderer.invoke('chat:models', agentId),
  decide: (brandId, threadId, messageId, card, decision) =>
    ipcRenderer.invoke('chat:decide', brandId, threadId, messageId, card, decision),
  usage: () => ipcRenderer.invoke('chat:usage'),
  onEvent: (fn) => {
    const listener = (_event: unknown, ev: ChatEvent): void => fn(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  // provider layer: approvals, questions, steer and queue, permission modes
  providers: () => ipcRenderer.invoke('chat:providers'),
  respondApproval: (brandId, threadId, requestId, decision, opts) =>
    ipcRenderer.invoke('chat:approval', brandId, threadId, requestId, decision, opts ?? {}),
  respondUserInput: (brandId, threadId, requestId, answers) =>
    ipcRenderer.invoke('chat:user-input', brandId, threadId, requestId, answers),
  steer: (brandId, threadId, text, agentId) => ipcRenderer.invoke('chat:steer', brandId, threadId, text, agentId),
  queue: (brandId, threadId, text, agentId) => ipcRenderer.invoke('chat:queue', brandId, threadId, text, agentId),
  unqueue: (brandId, threadId, queueId) => ipcRenderer.invoke('chat:unqueue', brandId, threadId, queueId),
  steerQueued: (brandId, threadId, queueId) => ipcRenderer.invoke('chat:queue-steer', brandId, threadId, queueId),
  listQueue: (brandId, threadId) => ipcRenderer.invoke('chat:queue-list', brandId, threadId),
  getPermissionMode: (brandId, threadId) => ipcRenderer.invoke('chat:permission-mode', brandId, threadId),
  setPermissionMode: (brandId, threadId, mode) => ipcRenderer.invoke('chat:set-permission-mode', brandId, threadId, mode),
  pending: (brandId, threadId) => ipcRenderer.invoke('chat:pending', brandId, threadId),
  onProviderEvent: (fn) => {
    const listener = (_event: unknown, ev: ProviderChatEvent): void => fn(ev)
    ipcRenderer.on('chat:provider-event', listener)
    return () => ipcRenderer.removeListener('chat:provider-event', listener)
  }
}
