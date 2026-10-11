import { contextBridge, ipcRenderer } from 'electron'
import type { AdblockCount, AppData, StatPlatform, TrendDeckApi, TrendFeed } from '@shared/types'

const api: TrendDeckApi = {
  platform: process.platform,
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onMaximized: (fn) => {
    const listener = (_event: unknown, maximized: boolean): void => fn(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
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
  adblockAttach: (webContentsId: number, brandId: string, siteId: string) =>
    ipcRenderer.invoke('adblock:attach', webContentsId, brandId, siteId),
  onAdblockCount: (fn) => {
    const listener = (_event: unknown, count: AdblockCount): void => fn(count)
    ipcRenderer.on('adblock:count', listener)
    return () => ipcRenderer.removeListener('adblock:count', listener)
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
  }
}

contextBridge.exposeInMainWorld('trenddeck', api)
