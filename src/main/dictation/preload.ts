import type { IpcRenderer } from 'electron'
import { DICTATION_CHANNELS, type DictationApi } from '../../shared/dictation'

export function dictationBridge(ipcRenderer: Pick<IpcRenderer, 'invoke'>): DictationApi {
  return {
    getConfig: () => ipcRenderer.invoke(DICTATION_CHANNELS.getConfig),
    saveConfig: (options) => ipcRenderer.invoke(DICTATION_CHANNELS.saveConfig, options),
    saveApiKey: (key) => ipcRenderer.invoke(DICTATION_CHANNELS.saveApiKey, key),
    transcribe: (audio) => ipcRenderer.invoke(DICTATION_CHANNELS.transcribe, audio),
    cancel: () => ipcRenderer.invoke(DICTATION_CHANNELS.cancel)
  }
}
