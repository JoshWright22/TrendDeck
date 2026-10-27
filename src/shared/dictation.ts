import type { SpokenWord } from './speech'

// dictation: one active source turns speech into text. either a local model from the catalog,
// downloaded once and run in a worker on this computer, or a provider configured in Settings
// (a cloud API or a transcription server on this computer). keys stay in main

declare global {
  interface Window { trenddeckDictation: DictationApi }
}

// ---------- local models ----------

export type LocalDtype = 'fp32' | 'fp16' | 'q8' | 'q4'
export type LocalDevice = 'auto' | 'webgpu' | 'wasm'
export type LocalFamily = 'whisper' | 'moonshine'
export const LOCAL_DTYPES: readonly LocalDtype[] = ['fp32', 'fp16', 'q8', 'q4']
export const LOCAL_DEVICES: readonly LocalDevice[] = ['auto', 'webgpu', 'wasm']

// the onnx file transformers.js picks for a dtype: onnx/<name><suffix>.onnx
export type OnnxDtype = 'fp32' | 'fp16' | 'q8' | 'q4'
export const ONNX_SUFFIX: Record<OnnxDtype, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' }

export interface LocalVariant {
  // what each part loads as. q8 for Whisper keeps the encoder in fp32, it loses the most when quantized
  encoder: OnnxDtype
  decoder: OnnxDtype
  // approximate download size, the exact sizes come from Hugging Face when it downloads
  bytes: number
}

export interface LocalModelInfo {
  id: string
  label: string
  repo: string
  family: LocalFamily
  englishOnly: boolean
  // exact: aligned per word. approximate: spread over each segment by length
  wordTimes: 'exact' | 'approximate'
  speed: string
  note: string
  variants: Partial<Record<LocalDtype, LocalVariant>>
  defaultDtype: LocalDtype
  custom?: boolean
}

// the small json files every model needs next to its onnx files
export const LOCAL_CONFIG_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']
// about 2.8 MB of tokenizer and config per variant
const CONFIG_BYTES = 2_770_000

const MB = 1_000_000
type Sizes = Partial<Record<LocalDtype, [OnnxDtype, OnnxDtype, number, number]>>

function variants(sizes: Sizes): Partial<Record<LocalDtype, LocalVariant>> {
  const out: Partial<Record<LocalDtype, LocalVariant>> = {}
  for (const [key, [encoder, decoder, enc, dec]] of Object.entries(sizes) as [LocalDtype, [OnnxDtype, OnnxDtype, number, number]][]) {
    out[key] = { encoder, decoder, bytes: Math.round((enc + dec) * MB) + CONFIG_BYTES }
  }
  return out
}

function whisper(
  id: string, label: string, speed: string, note: string, sizes: Sizes, defaultDtype: LocalDtype,
  opts: { repo?: string; wordTimes?: 'exact' | 'approximate' } = {}
): LocalModelInfo {
  return {
    id, label, speed, note, defaultDtype,
    repo: opts.repo ?? `onnx-community/${id}_timestamped`,
    family: 'whisper',
    englishOnly: /\.en$/.test(id),
    wordTimes: opts.wordTimes ?? 'exact',
    variants: variants(sizes)
  }
}

const TINY: Sizes = { fp32: ['fp32', 'fp32', 32.9, 118.7], fp16: ['fp16', 'fp16', 16.5, 59.6], q8: ['fp32', 'q8', 32.9, 30.7], q4: ['q4', 'q4', 9.0, 86.8] }
const BASE: Sizes = { fp32: ['fp32', 'fp32', 82.5, 208.7], fp16: ['fp16', 'fp16', 41.3, 104.7], q8: ['fp32', 'q8', 82.5, 53.7], q4: ['q4', 'q4', 18.8, 123.7] }
const SMALL: Sizes = { fp32: ['fp32', 'fp32', 352.8, 615.7], fp16: ['fp16', 'fp16', 176.5, 308.5], q8: ['fp32', 'q8', 352.8, 156.8], q4: ['q4', 'q4', 66.2, 233.4] }
const MEDIUM: Sizes = { fp16: ['fp16', 'fp16', 614.6, 915.0], q8: ['q8', 'q8', 313.0, 673.0], q4: ['q4', 'q4', 210.0, 469.0] }

export const LOCAL_MODELS: readonly LocalModelInfo[] = [
  whisper('whisper-tiny', 'Whisper Tiny', 'Fastest', 'Smallest. Makes more mistakes.', TINY, 'q8'),
  whisper('whisper-tiny.en', 'Whisper Tiny (English)', 'Fastest', 'English only, a little better than Tiny for English.', TINY, 'q8'),
  whisper('whisper-base', 'Whisper Base', 'Fast', 'Good for most dictation.', BASE, 'q8'),
  whisper('whisper-base.en', 'Whisper Base (English)', 'Fast', 'English only, a little better than Base for English.', BASE, 'q8'),
  whisper('whisper-small', 'Whisper Small', 'Medium', 'More accurate. Slower without a GPU.', SMALL, 'q8'),
  whisper('whisper-small.en', 'Whisper Small (English)', 'Medium', 'English only.', SMALL, 'q8'),
  whisper('whisper-medium', 'Whisper Medium', 'Slow', 'Accurate. Needs a GPU to feel quick.', MEDIUM, 'q4'),
  whisper('whisper-medium.en', 'Whisper Medium (English)', 'Slow', 'English only. Needs a GPU to feel quick.', MEDIUM, 'q4'),
  whisper('whisper-large-v3-turbo', 'Whisper Large v3 Turbo', 'Fast on a GPU, slow on the CPU', 'Most accurate. Needs a good GPU.',
    { fp16: ['fp16', 'fp16', 1274.4, 344.3], q8: ['q8', 'q8', 644.9, 440.0], q4: ['q4', 'q4', 425.0, 334.2] }, 'q4'),
  whisper('distil-small.en', 'Distil-Whisper Small (English)', 'Fast', 'English only. Close to Small, about twice as fast.',
    { fp32: ['fp32', 'fp32', 352.8, 312.3], fp16: ['fp16', 'fp16', 176.6, 156.4], q8: ['fp32', 'q8', 352.8, 80.0], q4: ['q4', 'q4', 66.2, 184.9] }, 'q8',
    { repo: 'onnx-community/distil-small.en', wordTimes: 'approximate' }),
  whisper('distil-large-v3.5', 'Distil-Whisper Large v3.5', 'Medium on a GPU', 'Close to Large v3, faster. Needs a good GPU.',
    { fp16: ['fp16', 'fp16', 1274.4, 239.0], q8: ['q8', 'q8', 644.9, 385.0], q4: ['q4', 'q4', 425.0, 301.0] }, 'q4',
    { repo: 'onnx-community/distil-large-v3.5-ONNX', wordTimes: 'approximate' }),
  {
    id: 'moonshine-tiny', label: 'Moonshine Tiny', repo: 'onnx-community/moonshine-tiny-ONNX', family: 'moonshine', englishOnly: true,
    wordTimes: 'approximate', speed: 'Fastest', note: 'English only. Very small and quick, good for short commands.', defaultDtype: 'q8',
    variants: variants({ fp32: ['fp32', 'fp32', 30.6, 78.0], fp16: ['fp16', 'fp16', 15.9, 76.1], q8: ['q8', 'q8', 8.1, 20.2], q4: ['q4', 'q4', 10.6, 44.9] })
  },
  {
    id: 'moonshine-base', label: 'Moonshine Base', repo: 'onnx-community/moonshine-base-ONNX', family: 'moonshine', englishOnly: true,
    wordTimes: 'approximate', speed: 'Fast', note: 'English only. Small and quick.', defaultDtype: 'q8',
    variants: variants({ fp32: ['fp32', 'fp32', 81.0, 166.0], fp16: ['fp16', 'fp16', 40.6, 161.0], q8: ['q8', 'q8', 20.6, 42.4], q4: ['q4', 'q4', 25.0, 73.0] })
  }
]

export const DEFAULT_LOCAL_MODEL = 'whisper-base'

// a custom entry is any onnx-community repo, stored as custom-<name>
export const CUSTOM_REPO = /^onnx-community\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/
export const CUSTOM_ID = /^custom-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

export function customRepoId(repo: string): string | null {
  const m = CUSTOM_REPO.exec(repo)
  if (!m || m[1].includes('..')) return null
  return `custom-${m[1]}`
}

export function localModel(id: unknown, custom: readonly LocalModelInfo[] = []): LocalModelInfo | undefined {
  if (typeof id !== 'string') return undefined
  return LOCAL_MODELS.find((m) => m.id === id) ?? custom.find((m) => m.id === id)
}

// the files one variant needs, relative to the model folder
export function variantFiles(info: LocalModelInfo, dtype: LocalDtype): string[] {
  const v = info.variants[dtype]
  if (!v) return []
  return [...LOCAL_CONFIG_FILES, `onnx/encoder_model${ONNX_SUFFIX[v.encoder]}.onnx`, `onnx/decoder_model_merged${ONNX_SUFFIX[v.decoder]}.onnx`]
}

// languages Whisper knows, '' lets it detect the language
export const WHISPER_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: '', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'pl', label: 'Polish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'el', label: 'Greek' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'he', label: 'Hebrew' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' }
]

// what Settings shows per local model
export interface LocalModelState {
  id: string
  installed: LocalDtype[]
  downloading: { dtype: LocalDtype; received: number; total: number }[]
}

export interface LocalModelsState {
  models: LocalModelState[]
  // everything under userData/stt/models
  diskBytes: number
}

export interface LocalModelProgress {
  id: string
  dtype: LocalDtype
  state: 'downloading' | 'done' | 'cancelled' | 'error'
  received: number
  total: number
  error?: string
}

export interface LocalPrefs {
  dtype: LocalDtype
  device: LocalDevice
}

// ---------- providers (metadata the page may see, no secrets) ----------

export interface SttFieldInfo {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  kind?: string
  options?: ({ value: string; label: string } | string)[]
}

export interface SttModelInfo {
  id: string
  label: string
  wordTimestamps: boolean
  languages?: 'multi' | 'en'
  note?: string
}

export interface SttProviderInfo {
  id: string
  label: string
  kind: 'api' | 'local-server'
  fields: SttFieldInfo[]
  defaultModel: string
  staticModels: SttModelInfo[]
  canListModels: boolean
  canTest: boolean
  supportsWordTimestamps: boolean
  supportsStreaming: boolean
  unavailable?: string
}

// a configured provider. secret field values never come back, only whether one is saved
export interface ProviderConfig {
  id: string
  providerId: string
  label: string
  values: Record<string, string>
  hasSecret: Record<string, boolean>
  model: string
  // where the audio goes, e.g. api.openai.com
  host: string
  kind: 'api' | 'local-server'
}

// a save from Settings. secrets: a new value replaces, '' keeps the saved one, null removes it
export interface ProviderInput {
  id?: string
  providerId: string
  label?: string
  values: Record<string, string | null>
  model: string
}

// ---------- options ----------

// 'local:<model id>' or 'provider:<config id>'
export type DictationSource = string

export interface DictationOptions {
  source: DictationSource
  // per local model: which download it uses and where it runs
  localPrefs: Record<string, LocalPrefs>
  // ISO 639-1 code, '' detects the language. English-only models ignore it
  language: string
  // the composer sends the message on its own after this much silence
  autoSend: boolean
  autoSendPauseMs: number
  // held to talk in the composer, e.g. "Ctrl+Space"
  holdKey: string
  // the composer keeps listening without holding a key
  handsFree: boolean
}

export interface DictationConfig extends DictationOptions {
  providers: ProviderConfig[]
  customModels: LocalModelInfo[]
}

export interface DictationAudio {
  bytes: ArrayBuffer
  mimeType: string
}

// what a provider gave back
export interface ApiTranscript {
  text: string
  words: SpokenWord[]
  wordTimesApproximate: boolean
  language?: string
  model: string
}

export interface DictationApi {
  getConfig(): Promise<DictationConfig>
  // any subset of the options, the rest stay as saved
  saveConfig(options: Partial<DictationOptions>): Promise<DictationConfig>
  // the active source, local models only when downloaded
  setSource(source: DictationSource): Promise<DictationConfig>
  // through the active provider in main
  transcribe(audio: DictationAudio): Promise<ApiTranscript>
  cancel(): Promise<void>

  models(): Promise<LocalModelsState>
  downloadModel(id: string, dtype: LocalDtype): Promise<LocalModelsState>
  cancelDownload(id: string, dtype: LocalDtype): Promise<void>
  // without a dtype, every download of that model
  deleteModel(id: string, dtype?: LocalDtype): Promise<LocalModelsState>
  addCustomModel(repo: string): Promise<DictationConfig>
  removeCustomModel(id: string): Promise<DictationConfig>
  onModelProgress(fn: (progress: LocalModelProgress) => void): () => void
  // the saved config changed outside this page, e.g. the agent set dictation up
  onConfigChanged(fn: (config: DictationConfig) => void): () => void

  providers(): Promise<SttProviderInfo[]>
  saveProvider(input: ProviderInput): Promise<DictationConfig>
  deleteProvider(id: string): Promise<DictationConfig>
  testProvider(id: string): Promise<{ ok: boolean; message: string }>
  providerModels(id: string): Promise<SttModelInfo[]>

  // only true in test runs started with TRENDDECK_TEST_HOOKS=1
  readonly testHooks: boolean
}

export const DICTATION_CHANNELS = {
  getConfig: 'dictation:get-config',
  saveConfig: 'dictation:save-config',
  setSource: 'dictation:set-source',
  transcribe: 'dictation:transcribe',
  cancel: 'dictation:cancel',
  models: 'dictation:models',
  downloadModel: 'dictation:download-model',
  cancelDownload: 'dictation:cancel-download',
  deleteModel: 'dictation:delete-model',
  addCustomModel: 'dictation:add-custom-model',
  removeCustomModel: 'dictation:remove-custom-model',
  providers: 'dictation:providers',
  saveProvider: 'dictation:save-provider',
  deleteProvider: 'dictation:delete-provider',
  testProvider: 'dictation:test-provider',
  providerModels: 'dictation:provider-models'
} as const

// main to the window, not an invoke channel
export const DICTATION_PROGRESS_EVENT = 'dictation:model-progress'
export const DICTATION_CONFIG_EVENT = 'dictation:config-changed'

export const DICTATION_MAX_BYTES = 25 * 1024 * 1024
export const DICTATION_TIMEOUT_MS = 120_000
export const DICTATION_MAX_RECORDING_MS = 120_000
export const DICTATION_PAUSE_MIN_MS = 500
export const DICTATION_PAUSE_MAX_MS = 5_000

export const DEFAULT_DICTATION_OPTIONS: DictationOptions = {
  source: `local:${DEFAULT_LOCAL_MODEL}`,
  localPrefs: {},
  language: '',
  autoSend: false,
  autoSendPauseMs: 1_500,
  holdKey: 'Ctrl+Space',
  handsFree: false
}

export function prefsFor(info: LocalModelInfo, prefs: Record<string, LocalPrefs>): LocalPrefs {
  const saved = prefs[info.id]
  const dtype = saved && info.variants[saved.dtype] ? saved.dtype : info.defaultDtype
  return { dtype, device: saved?.device ?? 'auto' }
}

export function sourceParts(source: string): { kind: 'local' | 'provider'; id: string } | null {
  const m = /^(local|provider):(.+)$/.exec(source)
  return m ? { kind: m[1] as 'local' | 'provider', id: m[2] } : null
}

// "Audio is sent to api.openai.com"
export function dictationHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

// words with times for a stretch of text that only has a start and end: spread over the span by
// character length. used when a model or provider gives segment times only
export function spreadWords(text: string, start: number, end: number): SpokenWord[] {
  const parts = text.split(/\s+/).filter(Boolean)
  if (!parts.length) return []
  const span = Math.max(0, end - start)
  const weights = parts.map((p) => p.length + 1)
  const total = weights.reduce((a, b) => a + b, 0)
  const out: SpokenWord[] = []
  let at = start
  for (let i = 0; i < parts.length; i++) {
    const len = (span * weights[i]) / total
    const round = (n: number): number => Math.round(n * 100) / 100
    out.push({ text: parts[i], start: round(at), end: round(i === parts.length - 1 ? end : at + len) })
    at += len
  }
  return out
}
