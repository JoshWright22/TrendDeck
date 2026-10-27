import { contextBridge, ipcRenderer } from 'electron'
import type { GatewayApi } from '@shared/gateway'
import type { PipelineApi } from '@shared/pipeline'

// the agent tool gateway and the pipeline, on window.trenddeckGateway and window.trenddeckPipeline

function listen<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const gateway: GatewayApi = {
  tools: () => ipcRenderer.invoke('gateway:tools'),
  getPolicy: (brandId) => ipcRenderer.invoke('gateway:policy-get', brandId),
  setPolicy: (brandId, policy) => ipcRenderer.invoke('gateway:policy-set', brandId, policy),
  pendingApprovals: () => ipcRenderer.invoke('gateway:approvals'),
  onApprovalRequest: (fn) => listen('gateway:approval-request', fn),
  onApprovalClosed: (fn) => listen('gateway:approval-closed', fn),
  respond: (res) => ipcRenderer.invoke('gateway:approval-respond', res),
  audit: (brandId, query) => ipcRenderer.invoke('gateway:audit-list', brandId, query ?? {}),
  onAudit: (fn) => listen('gateway:audit', fn),
  onDataChanged: (fn) => listen('gateway:data-changed', fn),
  replyDrafts: (brandId) => ipcRenderer.invoke('gateway:reply-drafts', brandId),
  removeReplyDraft: (brandId, id) => ipcRenderer.invoke('gateway:reply-draft-remove', brandId, id)
}

const pipeline: PipelineApi = {
  get: (brandId) => ipcRenderer.invoke('pipeline:get', brandId),
  set: (brandId, stages) => ipcRenderer.invoke('pipeline:set', brandId, stages),
  onChanged: (fn) => listen('pipeline:changed', fn),
  listRuns: (brandId, opts) => ipcRenderer.invoke('run:list', brandId, opts ?? {}),
  getRun: (brandId, runId) => ipcRenderer.invoke('run:get', brandId, runId),
  createRun: (brandId, input) => ipcRenderer.invoke('run:create', brandId, input),
  updateRun: (brandId, runId, patch) => ipcRenderer.invoke('run:update', brandId, runId, patch),
  advanceRun: (brandId, runId) => ipcRenderer.invoke('run:advance', brandId, runId),
  removeRun: (brandId, runId) => ipcRenderer.invoke('run:remove', brandId, runId),
  onRunChanged: (fn) => listen('run:changed', fn),
  pendingQuestions: () => ipcRenderer.invoke('pipeline:questions'),
  onQuestion: (fn) => listen('pipeline:question', fn),
  onQuestionClosed: (fn) => listen('pipeline:question-closed', fn),
  answer: (a) => ipcRenderer.invoke('pipeline:answer', a)
}

contextBridge.exposeInMainWorld('trenddeckGateway', gateway)
contextBridge.exposeInMainWorld('trenddeckPipeline', pipeline)
