import { ipcRenderer, webUtils } from 'electron'
import type { EmbedApi } from '@shared/craft-embed'

// the live Craft editors in the chat, exposed as window.trenddeckEmbed. see main/cards/embed.ts

export const embedApi: EmbedApi = {
  create: (brandId, threadId, projectId, appId) => ipcRenderer.invoke('embed:create', brandId, threadId, projectId, appId),
  open: (brandId, cardId) => ipcRenderer.invoke('embed:open', brandId, cardId),
  still: (brandId, cardId, seconds) => ipcRenderer.invoke('embed:still', brandId, cardId, seconds ?? null),
  sequence: (brandId, cardId) => ipcRenderer.invoke('embed:sequence', brandId, cardId),
  addMarkers: (brandId, cardId, comments) => ipcRenderer.invoke('embed:add-markers', brandId, cardId, comments),
  undoTurn: (brandId, cardId) => ipcRenderer.invoke('embed:undo-turn', brandId, cardId),
  keepTurn: (brandId, cardId) => ipcRenderer.invoke('embed:keep-turn', brandId, cardId),
  showAlternative: (brandId, cardId, sequence) => ipcRenderer.invoke('embed:show-alternative', brandId, cardId, sequence),
  keepAlternative: (brandId, cardId, sequence) => ipcRenderer.invoke('embed:keep-alternative', brandId, cardId, sequence),
  undoAlternative: (brandId, cardId) => ipcRenderer.invoke('embed:undo-alternative', brandId, cardId),
  importFiles: (brandId, cardId, paths) => ipcRenderer.invoke('embed:import-files', brandId, cardId, paths),
  importMedia: (brandId, cardId, mediaId) => ipcRenderer.invoke('embed:import-media', brandId, cardId, mediaId),
  latestRender: (brandId, cardId) => ipcRenderer.invoke('embed:latest-render', brandId, cardId),
  pathForFile: (file) => webUtils.getPathForFile(file)
}
