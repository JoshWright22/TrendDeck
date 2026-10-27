import type { IpcRenderer } from 'electron'
import {
  DICTATION_CHANNELS as C, DICTATION_CONFIG_EVENT, DICTATION_PROGRESS_EVENT, type DictationApi, type DictationConfig, type LocalModelProgress
} from '../../shared/dictation'

export function dictationBridge(ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): DictationApi {
  return {
    getConfig: () => ipcRenderer.invoke(C.getConfig),
    saveConfig: (options) => ipcRenderer.invoke(C.saveConfig, options),
    setSource: (source) => ipcRenderer.invoke(C.setSource, source),
    transcribe: (audio) => ipcRenderer.invoke(C.transcribe, audio),
    cancel: () => ipcRenderer.invoke(C.cancel),
    models: () => ipcRenderer.invoke(C.models),
    downloadModel: (id, dtype) => ipcRenderer.invoke(C.downloadModel, id, dtype),
    cancelDownload: (id, dtype) => ipcRenderer.invoke(C.cancelDownload, id, dtype),
    deleteModel: (id, dtype) => ipcRenderer.invoke(C.deleteModel, id, dtype),
    addCustomModel: (repo) => ipcRenderer.invoke(C.addCustomModel, repo),
    removeCustomModel: (id) => ipcRenderer.invoke(C.removeCustomModel, id),
    onModelProgress: (fn) => {
      const listener = (_event: unknown, progress: LocalModelProgress): void => fn(progress)
      ipcRenderer.on(DICTATION_PROGRESS_EVENT, listener)
      return () => { ipcRenderer.removeListener(DICTATION_PROGRESS_EVENT, listener) }
    },
    onConfigChanged: (fn) => {
      const listener = (_event: unknown, config: DictationConfig): void => fn(config)
      ipcRenderer.on(DICTATION_CONFIG_EVENT, listener)
      return () => { ipcRenderer.removeListener(DICTATION_CONFIG_EVENT, listener) }
    },
    providers: () => ipcRenderer.invoke(C.providers),
    saveProvider: (input) => ipcRenderer.invoke(C.saveProvider, input),
    deleteProvider: (id) => ipcRenderer.invoke(C.deleteProvider, id),
    testProvider: (id) => ipcRenderer.invoke(C.testProvider, id),
    providerModels: (id) => ipcRenderer.invoke(C.providerModels, id),
    // test runs only, see engine.ts
    testHooks: typeof process !== 'undefined' && process.env?.TRENDDECK_TEST_HOOKS === '1'
  }
}
