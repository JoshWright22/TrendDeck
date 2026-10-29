import { ipcRenderer } from 'electron'
import type { CardsApi, CardsChanged } from '@shared/cards'
import type { StorageApi } from '@shared/storage'

// chat cards and storage settings, exposed as window.trenddeckCards and window.trenddeckStorage

export const cardsApi: CardsApi = {
  previewSpeed: () => ipcRenderer.invoke('preview-speed:get'),
  onPreviewSpeed: (fn) => {
    const listener = (_e: unknown, n: number): void => fn(n)
    ipcRenderer.on('preview-speed:changed', listener)
    return () => ipcRenderer.removeListener('preview-speed:changed', listener)
  },
  list: (brandId, threadId) => ipcRenderer.invoke('cards:list', brandId, threadId),
  answer: (brandId, cardId, answer) => ipcRenderer.invoke('cards:answer', brandId, cardId, answer),
  saveFrame: (brandId, cardId, frame) => ipcRenderer.invoke('cards:save-frame', brandId, cardId, frame),
  checkpoint: (brandId, cardId) => ipcRenderer.invoke('cards:checkpoint', brandId, cardId),
  restoreCheckpoint: (brandId, cardId) => ipcRenderer.invoke('cards:restore-checkpoint', brandId, cardId),
  addToProject: (brandId, projectId, mediaId) => ipcRenderer.invoke('cards:add-to-project', brandId, projectId, mediaId),
  projectFileUrl: (brandId, ref) => `td-media://project/${brandId}/${ref.projectId}/${encodeURIComponent(ref.file)}`,
  history: (brandId, projectId) => ipcRenderer.invoke('cards:history', brandId, projectId),
  saveCheckpoint: (brandId, projectId, message) => ipcRenderer.invoke('cards:save-checkpoint', brandId, projectId, message),
  commitDiff: (brandId, projectId, commit) => ipcRenderer.invoke('cards:commit-diff', brandId, projectId, commit),
  restoreCommit: (brandId, projectId, commit) => ipcRenderer.invoke('cards:restore-commit', brandId, projectId, commit),
  onChanged: (fn) => {
    const listener = (_event: unknown, c: CardsChanged): void => fn(c)
    ipcRenderer.on('cards:changed', listener)
    return () => ipcRenderer.removeListener('cards:changed', listener)
  }
}

export const storageApi: StorageApi = {
  state: (brandId) => ipcRenderer.invoke('storage:state', brandId),
  setSettings: (brandId, patch) => ipcRenderer.invoke('storage:settings', brandId, patch),
  addRemote: (input) => ipcRenderer.invoke('storage:add-remote', input),
  onChanged: (fn) => {
    const listener = (): void => fn()
    ipcRenderer.on('storage:changed', listener)
    return () => ipcRenderer.removeListener('storage:changed', listener)
  }
}
