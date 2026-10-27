import { contextBridge, ipcRenderer } from 'electron'
import type { QcApi, QcProgress } from '@shared/qc'

// pre-publish checks, on window.trenddeckQc
const qc: QcApi = {
  run: (brandId, projectId, file, opts) => ipcRenderer.invoke('qc:run', brandId, projectId, file, opts),
  onProgress: (fn) => {
    const listener = (_event: unknown, p: QcProgress): void => fn(p)
    ipcRenderer.on('qc:progress', listener)
    return () => ipcRenderer.removeListener('qc:progress', listener)
  }
}

contextBridge.exposeInMainWorld('trenddeckQc', qc)
