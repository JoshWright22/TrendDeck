import { contextBridge, ipcRenderer } from 'electron'
import type { AppData, StatPlatform, TrendDeckApi, TrendFeed } from '@shared/types'
import { postingApi } from './posting'
import { mediaApi } from './media'
import type { McpApi } from '@shared/mcp'
import type { VaultApi } from '@shared/vault'
import { chatApi } from './chat'

const api: TrendDeckApi = {
  platform: process.platform,
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onMaximized: (fn) => {
    const listener = (_event: unknown, maximized: boolean): void => fn(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  onOpenUrl: (fn) => {
    const listener = (_event: unknown, url: string): void => fn(url)
    ipcRenderer.on('open:url', listener)
    return () => ipcRenderer.removeListener('open:url', listener)
  },
  posting: postingApi,
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data: AppData) => ipcRenderer.invoke('data:save', data),
  clearBrandSession: (brandId: string) => ipcRenderer.invoke('brand:clear-session', brandId),
  onBrandShortcut: (fn) => {
    const listener = (_event: unknown, index: number): void => fn(index)
    ipcRenderer.on('shortcut:brand', listener)
    return () => ipcRenderer.removeListener('shortcut:brand', listener)
  },
  getTrends: (brandId: string) => ipcRenderer.invoke('trends:get', brandId),
  refreshTrends: (brandId: string) => ipcRenderer.invoke('trends:refresh', brandId),
  onTrends: (fn) => {
    const listener = (_event: unknown, feed: TrendFeed): void => fn(feed)
    ipcRenderer.on('trends:update', listener)
    return () => ipcRenderer.removeListener('trends:update', listener)
  },
  loadDrafts: (brandId) => ipcRenderer.invoke('writer:load', brandId),
  saveDrafts: (brandId, doc) => ipcRenderer.invoke('writer:save', brandId, doc),
  loadAnalytics: (brandId) => ipcRenderer.invoke('analytics:load', brandId),
  saveAnalyticsConfig: (brandId, config) => ipcRenderer.invoke('analytics:config', brandId, config),
  refreshAnalytics: (brandId, platforms) => ipcRenderer.invoke('analytics:refresh', brandId, platforms),
  clearAnalytics: (brandId) => ipcRenderer.invoke('analytics:clear', brandId),
  onAnalyticsProgress: (fn) => {
    const listener = (_event: unknown, brandId: string, platform: StatPlatform | null): void =>
      fn(brandId, platform)
    ipcRenderer.on('analytics:progress', listener)
    return () => ipcRenderer.removeListener('analytics:progress', listener)
  },
  media: mediaApi,
  setSiteHidden: (webContentsId: number, hidden: boolean) => ipcRenderer.send('site:hidden', webContentsId, hidden),
  voiceLoad: (brandId) => ipcRenderer.invoke('voice:load', brandId),
  voiceSave: (brandId, data) => ipcRenderer.invoke('voice:save', brandId, data),
  voiceImport: (brandId, platforms) => ipcRenderer.invoke('voice:import', brandId, platforms)
}

contextBridge.exposeInMainWorld('trenddeck', api)

// agent access, kept apart from the main api so it can grow on its own
function listen<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const mcp: McpApi = {
  getState: () => ipcRenderer.invoke('mcp:state'),
  setGrant: (brandId, siteId, on) => ipcRenderer.invoke('mcp:grant', brandId, siteId, on),
  clearLog: (brandId) => ipcRenderer.invoke('mcp:clear-log', brandId),
  setPostStatus: (id, status) => ipcRenderer.invoke('mcp:post-status', id, status),
  shareTabOnce: (brandId, siteId) => ipcRenderer.invoke('mcp:share-once', brandId, siteId),
  sharedTab: () => ipcRenderer.invoke('mcp:shared'),
  onChanged: (fn) => listen('mcp:changed', () => fn()),
  onOpenSite: (fn) => listen('mcp:open-site', fn),
  onIdea: (fn) => listen('mcp:idea', fn)
}

contextBridge.exposeInMainWorld('trenddeckMcp', mcp)

// saved logins. there's no call that returns a password, main keeps those to itself
const vault: VaultApi = {
  getState: () => ipcRenderer.invoke('vault:state'),
  save: (brandId, siteId, login) => ipcRenderer.invoke('vault:save', brandId, siteId, login),
  remove: (brandId, siteId) => ipcRenderer.invoke('vault:remove', brandId, siteId),
  onChanged: (fn) => listen('vault:changed', () => fn()),
  onCodeRequest: (fn) => listen('vault:ask-code', fn),
  answerCode: (id, code) => ipcRenderer.invoke('vault:code', id, code)
}

contextBridge.exposeInMainWorld('trenddeckVault', vault)

contextBridge.exposeInMainWorld('trenddeckChat', chatApi)
