import { ipcRenderer } from 'electron'
import type { WorkspaceBridge } from '@shared/workspace'

// projects and pipelines, exposed as window.trenddeckWorkspace
export const workspaceApi: WorkspaceBridge = {
  getPipeline: (brandId) => ipcRenderer.invoke('workspace:pipeline-get', brandId),
  setPipeline: (brandId, stages) => ipcRenderer.invoke('workspace:pipeline-set', brandId, stages),
  listProjects: (brandId) => ipcRenderer.invoke('workspace:projects', brandId),
  saveProject: (brandId, project) => ipcRenderer.invoke('workspace:project-save', brandId, project),
  linkThread: (brandId, projectId, threadId) => ipcRenderer.invoke('workspace:link-thread', brandId, projectId, threadId),
  setChatProjects: (brandId, threadId, projectIds) => ipcRenderer.invoke('workspace:chat-projects-set', brandId, threadId, projectIds),
  // main changed trenddeck.json itself, e.g. an agent edited the pipeline
  onDataChanged: (fn) => {
    const listener: Parameters<typeof ipcRenderer.on>[1] = (_event, data) => fn(data)
    ipcRenderer.on('data:changed', listener)
    return () => ipcRenderer.removeListener('data:changed', listener)
  }
}
