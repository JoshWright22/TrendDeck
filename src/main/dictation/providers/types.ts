// the shape every speech-to-text adapter has. pure, no electron: main wires them to settings,
// key storage and the dictation ipc, these only build requests and read answers

export type Fetch = typeof globalThis.fetch

export interface SttField {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  kind?: 'text' | 'url' | 'select'
  options?: string[]
  // used when the field is left empty
  defaultValue?: string
}

export interface SttModel {
  id: string
  label: string
  wordTimestamps: boolean
  languages?: 'multi' | 'en'
  note?: string
}

export interface SttRequest {
  audio: ArrayBuffer
  // audio/wav normally
  mimeType: string
  model: string
  // ISO 639-1 or '' to detect
  language?: string
  prompt?: string
  signal?: AbortSignal
}

export interface SttWord {
  text: string
  // seconds from the start of the audio
  start: number
  end: number
}

export interface SttResult {
  text: string
  words: SttWord[]
  language?: string
  // true when the times are spread across segments, or missing (words: []) and need local alignment
  wordTimesApproximate: boolean
}

export type SttConfig = Record<string, string>

export interface SttProvider {
  id: string
  label: string
  kind: 'api' | 'local-server'
  // auth + endpoint/region fields
  fields: SttField[]
  defaultModel: string
  staticModels: SttModel[]
  // live list where the API offers one
  listModels?(cfg: SttConfig, fetch: Fetch, signal?: AbortSignal): Promise<SttModel[]>
  supportsWordTimestamps: boolean
  supportsStreaming: boolean
  // the host the audio goes to, for "Audio is sent to <host>". '' when the config can't say yet
  host(cfg: SttConfig): string
  transcribe(req: SttRequest, cfg: SttConfig, fetch: Fetch): Promise<SttResult>
  // cheap auth/connectivity check, never uploads audio
  test?(cfg: SttConfig, fetch: Fetch, signal?: AbortSignal): Promise<{ ok: boolean; message: string }>
  // set when the provider is listed but can't be used yet, e.g. "Coming later"
  unavailable?: string
  // the official API reference the adapter follows
  docsUrl: string
}
