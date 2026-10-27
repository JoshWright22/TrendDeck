import { ipcRenderer } from 'electron'
import type { VisualsApi } from '@shared/visuals'

// sketches, pasted images and visuals found online, exposed as window.trenddeckVisuals. there's no
// call that returns a Pexels or Pixabay key, main keeps them to itself

export const visualsApi: VisualsApi = {
  search: (brandId, threadId, input) => ipcRenderer.invoke('visuals:search', brandId, threadId, input),
  asset: (brandId, assetId) => ipcRenderer.invoke('visuals:asset', brandId, assetId),
  saveImage: (input) => ipcRenderer.invoke('visuals:save-image', input),
  fetchResult: (brandId, resultId) => ipcRenderer.invoke('visuals:fetch-result', brandId, resultId),
  fetchLink: (brandId, url) => ipcRenderer.invoke('visuals:fetch-link', brandId, url),
  resultToProject: (brandId, projectId, resultId, threadId) => ipcRenderer.invoke('visuals:result-to-project', brandId, projectId, resultId, threadId),
  assetToProject: (brandId, projectId, assetId, threadId) => ipcRenderer.invoke('visuals:asset-to-project', brandId, projectId, assetId, threadId),
  showCard: (brandId, threadId, assetId) => ipcRenderer.invoke('visuals:show-card', brandId, threadId, assetId),
  keys: () => ipcRenderer.invoke('visuals:keys'),
  setKey: (provider, key) => ipcRenderer.invoke('visuals:set-key', provider, key),
  clearKey: (provider) => ipcRenderer.invoke('visuals:clear-key', provider)
}
