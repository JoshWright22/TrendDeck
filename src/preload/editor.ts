import { ipcRenderer } from 'electron'
import { EDITOR_CHANNELS as C, type EditorBridge, type EditorChangeEvent, type ExportProgress } from '@shared/editor/ipc'

// the editor's half of the preload, exposed as window.trenddeckEditor
function listen<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const editorApi: EditorBridge = {
  list: () => ipcRenderer.invoke(C.list),
  create: (name) => ipcRenderer.invoke(C.create, name),
  open: (filePath) => ipcRenderer.invoke(C.open, filePath),
  close: (projectId, opts) => ipcRenderer.invoke(C.close, projectId, opts),
  save: (projectId, filePath) => ipcRenderer.invoke(C.save, projectId, filePath),
  snapshot: (projectId) => ipcRenderer.invoke(C.snapshot, projectId),
  execute: (projectId, commandId, args) => ipcRenderer.invoke(C.execute, projectId, commandId, args),
  batch: (projectId, steps, opts) => ipcRenderer.invoke(C.batch, projectId, steps, opts),
  undo: (projectId) => ipcRenderer.invoke(C.undo, projectId),
  redo: (projectId) => ipcRenderer.invoke(C.redo, projectId),
  checkpoint: (projectId, label) => ipcRenderer.invoke(C.checkpoint, projectId, label),
  revert: (projectId, checkpointId) => ipcRenderer.invoke(C.revert, projectId, checkpointId),
  importMedia: (projectId, paths, binId) => ipcRenderer.invoke(C.importMedia, projectId, paths, binId),
  renderFrame: (projectId, sequenceId, tick, opts) => ipcRenderer.invoke(C.renderFrame, projectId, sequenceId, tick, opts),
  waveform: (projectId, mediaId) => ipcRenderer.invoke(C.waveform, projectId, mediaId),
  thumbnails: (projectId, mediaId, count, height) => ipcRenderer.invoke(C.thumbnails, projectId, mediaId, count, height),
  makeProxy: (projectId, mediaId) => ipcRenderer.invoke(C.makeProxy, projectId, mediaId),
  exportStart: (projectId, sequenceId, preset, outputPath) => ipcRenderer.invoke(C.exportStart, projectId, sequenceId, preset, outputPath),
  exportCancel: (jobId) => ipcRenderer.invoke(C.exportCancel, jobId),
  recoverable: () => ipcRenderer.invoke(C.recoverable),
  recover: (projectId) => ipcRenderer.invoke(C.recover, projectId),
  onChanged: (fn) => listen<EditorChangeEvent>(C.changed, fn),
  onExportProgress: (fn) => listen<ExportProgress>(C.exportProgress, fn)
}
