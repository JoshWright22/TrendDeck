import { ipcRenderer, webUtils } from 'electron'
import type { MediaApi } from '@shared/media'

export const mediaApi: MediaApi = {
  library: (brandId) => ipcRenderer.invoke('media:library', brandId),
  list: (brandId, filter) => ipcRenderer.invoke('media:list', brandId, filter),
  pickAndAdd: (brandId, folders) => ipcRenderer.invoke('media:pick-add', brandId, folders),
  addPaths: (brandId, paths) => ipcRenderer.invoke('media:add-paths', brandId, paths),
  saveRecording: (brandId, name, mimeType, bytes) =>
    ipcRenderer.invoke('media:save-recording', brandId, name, mimeType, bytes),
  pathForFile: (file) => webUtils.getPathForFile(file),
  edit: (brandId, ids, edit) => ipcRenderer.invoke('media:edit', brandId, ids, edit),
  remove: (brandId, ids) => ipcRenderer.invoke('media:remove', brandId, ids),
  undoRemove: (brandId, ids) => ipcRenderer.invoke('media:undo-remove', brandId, ids),
  copyIn: (brandId, ids) => ipcRenderer.invoke('media:copy-in', brandId, ids),
  relink: (brandId, id) => ipcRenderer.invoke('media:relink', brandId, id),
  reveal: (brandId, id) => ipcRenderer.invoke('media:reveal', brandId, id),
  markPosted: (brandId, id, platform, url) => ipcRenderer.invoke('media:mark-posted', brandId, id, platform, url),
  unmarkPosted: (brandId, id, platform, at) =>
    ipcRenderer.invoke('media:unmark-posted', brandId, id, platform, at),
  setProbe: (brandId, id, probe) => ipcRenderer.invoke('media:probe', brandId, id, probe),
  setCollections: (brandId, collections) => ipcRenderer.invoke('media:collections', brandId, collections),
  setCopyByDefault: (brandId, on) => ipcRenderer.invoke('media:copy-default', brandId, on),
  addWatch: (brandId) => ipcRenderer.invoke('media:watch-add', brandId),
  editWatch: (brandId, watchId, on) => ipcRenderer.invoke('media:watch-edit', brandId, watchId, on),
  removeWatch: (brandId, watchId) => ipcRenderer.invoke('media:watch-remove', brandId, watchId),
  onChange: (fn) => {
    const listener = (_event: unknown, brandId: string): void => fn(brandId)
    ipcRenderer.on('media:changed', listener)
    return () => ipcRenderer.removeListener('media:changed', listener)
  }
}
