import { contextBridge, ipcRenderer } from 'electron'
import type { AppData, TrendDeckApi } from '@shared/types'

const api: TrendDeckApi = {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data: AppData) => ipcRenderer.invoke('data:save', data),
  clearBrandSession: (brandId: string) => ipcRenderer.invoke('brand:clear-session', brandId)
}

contextBridge.exposeInMainWorld('trenddeck', api)
