export type DictationMode = 'local' | 'api'

declare global {
  interface Window { trenddeckDictation: DictationApi }
}

export interface DictationOptions {
  mode: DictationMode
  baseUrl: string
  model: string
}

export interface DictationConfig extends DictationOptions {
  hasKey: boolean
}

export interface DictationAudio {
  bytes: ArrayBuffer
  mimeType: string
}

export interface DictationApi {
  getConfig(): Promise<DictationConfig>
  saveConfig(options: DictationOptions): Promise<DictationConfig>
  saveApiKey(key: string): Promise<DictationConfig>
  transcribe(audio: DictationAudio): Promise<string>
  cancel(): Promise<void>
}

export const DICTATION_CHANNELS = {
  getConfig: 'dictation:get-config',
  saveConfig: 'dictation:save-config',
  saveApiKey: 'dictation:save-api-key',
  transcribe: 'dictation:transcribe',
  cancel: 'dictation:cancel'
} as const

export const DICTATION_MAX_BYTES = 25 * 1024 * 1024
export const DICTATION_TIMEOUT_MS = 120_000
export const DICTATION_MAX_RECORDING_MS = 120_000

export const DEFAULT_DICTATION_OPTIONS: DictationOptions = {
  mode: 'local',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'whisper-1'
}
