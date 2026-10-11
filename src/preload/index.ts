import { contextBridge, ipcRenderer } from 'electron'
import type { AdblockCount, AppData, TrendDeckApi, TrendFeed } from '@shared/types'
import { postingApi } from './posting'

const api: TrendDeckApi = {
  platform: process.platform,
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onMaximized: (fn) => {
    const listener = (_event: unknown, maximized: boolean): void => fn(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
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
  adblockAttach: (webContentsId: number, brandId: string, siteId: string) =>
    ipcRenderer.invoke('adblock:attach', webContentsId, brandId, siteId),
  onAdblockCount: (fn) => {
    const listener = (_event: unknown, count: AdblockCount): void => fn(count)
    ipcRenderer.on('adblock:count', listener)
    return () => ipcRenderer.removeListener('adblock:count', listener)
  }
}

contextBridge.exposeInMainWorld('trenddeck', api)
