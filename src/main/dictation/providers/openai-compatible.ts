// one adapter for every OpenAI-style POST /audio/transcriptions: OpenAI itself, Groq, Together,
// OpenRouter, any HTTPS gateway, and Speaches / LocalAI / other servers on this computer.
//   OpenAI      https://platform.openai.com/docs/api-reference/audio/createTranscription
//   Groq        https://console.groq.com/docs/speech-to-text
//   Together    https://docs.together.ai/reference/audio-transcriptions
//               https://docs.together.ai/docs/inference/transcription/features
//   OpenRouter  https://openrouter.ai/docs/guides/overview/multimodal/stt
//   Speaches    https://speaches.ai/usage/speech-to-text/
//   LocalAI     https://localai.io/docs/features/audio-to-text/
// verbose_json + timestamp_granularities[]=word gives { text, language, words: [{ word, start, end }],
// segments: [{ text, start, end }] }; plain json only { text }
import {
  SttError, asArray, asRecord, audioMime, checkAudio, dedupeModels, field, joinUrl, languageCode, loopbackBaseUrl,
  modelId, remoteBaseUrl, requestJson, requestOk, secret, testWith
} from './http'
import { result, word, type TimedSegment } from './timing'
import type { Fetch, SttConfig, SttField, SttModel, SttProvider, SttRequest, SttResult, SttWord } from './types'

// true: verbose_json with word times. false: plain json. 'try': verbose first, plain json on HTTP 400
export type VerboseMode = boolean | 'try'

export interface CompatPreset {
  id: string
  label: string
  kind: 'api' | 'local-server'
  docsUrl: string
  // fixed base URL (…/v1). without it the base comes from the baseUrl field
  baseUrl?: string
  // a different fixed base for some models (Fireworks serves turbo from its own host)
  baseUrlFor?(model: string): string | undefined
  defaultBaseUrl?: string
  keyRequired: boolean
  defaultModel: string
  staticModels: SttModel[]
  verbose(model: string): VerboseMode
  // GET <base><modelsPath> lists models; the filter keeps the transcription ones
  modelsPath?: string
  modelsQuery?: Record<string, string>
  modelFilter?(entry: Record<string, unknown>): SttModel | undefined
  // GET <base><testPath> for test(); defaults to modelsPath
  testPath?: string
  // prompt has no effect on some (OpenRouter), skip it there
  sendPrompt?: boolean
  note?: string
}

const KEY_FIELD = (required: boolean, placeholder?: string): SttField => ({
  key: 'apiKey', label: required ? 'API key' : 'API key (optional)', secret: true, required, placeholder
})

export function compatFields(p: CompatPreset): SttField[] {
  const fields: SttField[] = []
  if (!p.baseUrl) {
    fields.push({
      key: 'baseUrl', label: p.kind === 'local-server' ? 'Server URL' : 'Base URL', secret: false, required: true, kind: 'url',
      placeholder: p.defaultBaseUrl ?? (p.kind === 'local-server' ? 'http://127.0.0.1:8080/v1' : 'https://api.example.com/v1'),
      defaultValue: p.defaultBaseUrl
    })
  }
  fields.push(KEY_FIELD(p.keyRequired))
  return fields
}

export function compatBase(p: CompatPreset, cfg: SttConfig): URL {
  if (p.baseUrl) return remoteBaseUrl(p.baseUrl)
  const raw = field(cfg, 'baseUrl', compatFields(p))
  return p.kind === 'local-server' ? loopbackBaseUrl(raw) : remoteBaseUrl(raw)
}

function headers(p: CompatPreset, cfg: SttConfig): Record<string, string> {
  const key = secret(cfg, 'apiKey')
  // hosted APIs always get the header; a server that runs without a key gets none
  return key || p.keyRequired ? { Authorization: `Bearer ${key}` } : {}
}

export function buildForm(req: SttRequest, model: string, verbose: boolean, sendPrompt: boolean): FormData {
  const audio = checkAudio(req.audio)
  const { mime, extension } = audioMime(req.mimeType)
  const language = languageCode(req.language)
  const form = new FormData()
  // model before file, so servers like Together can route before the upload finishes
  form.append('model', model)
  form.append('file', new Blob([audio], { type: mime }), `audio.${extension}`)
  if (language) form.append('language', language)
  if (sendPrompt && req.prompt?.trim()) form.append('prompt', req.prompt.trim().slice(0, 2000))
  form.append('response_format', verbose ? 'verbose_json' : 'json')
  if (verbose) {
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
  }
  return form
}

// LocalAI reports times in nanoseconds; no recording is 115 days long, so anything past 1e7 is ns
function scaleFor(values: number[]): number {
  return values.some((v) => v > 1e7) ? 1e-9 : 1
}

export function parseOpenAiTranscript(body: unknown, provider: string): SttResult {
  const b = asRecord(body)
  if (typeof b.text !== 'string') throw new SttError(`${provider} returned an unreadable response.`)
  const rawWords = asArray(b.words)
  const rawSegments = asArray(b.segments)
  const scale = scaleFor([...rawWords, ...rawSegments].flatMap((x) => [Number(x.start), Number(x.end)]).filter(Number.isFinite))
  const words: SttWord[] = []
  for (const w of rawWords) {
    const parsed = word(w.word ?? w.text, w.start, w.end, scale)
    if (parsed) words.push(parsed)
  }
  const segments: TimedSegment[] = []
  for (const s of rawSegments) {
    const start = Number(s.start) * scale
    const end = Number(s.end) * scale
    if (typeof s.text === 'string' && Number.isFinite(start) && Number.isFinite(end)) segments.push({ text: s.text, start, end })
  }
  return result(b.text, words, segments, typeof b.language === 'string' ? b.language : undefined)
}

export function createCompatProvider(p: CompatPreset): SttProvider {
  const fields = compatFields(p)
  const provider: SttProvider = {
    id: p.id,
    label: p.label,
    kind: p.kind,
    fields,
    defaultModel: p.defaultModel,
    staticModels: p.staticModels,
    supportsWordTimestamps: p.staticModels.some((m) => m.wordTimestamps) || p.kind === 'local-server' || !p.baseUrl,
    supportsStreaming: false,
    docsUrl: p.docsUrl,
    host(cfg) {
      try {
        return compatBase(p, cfg).host
      } catch {
        return ''
      }
    },
    async transcribe(req, cfg, fetch) {
      const model = modelId(req.model, p.defaultModel)
      const special = p.baseUrlFor?.(model)
      const base = special ? remoteBaseUrl(special) : compatBase(p, cfg)
      const url = joinUrl(base, '/audio/transcriptions')
      const h = headers(p, cfg)
      const mode = p.verbose(model)
      const call = (verbose: boolean): Promise<unknown> =>
        requestJson(fetch, url, { method: 'POST', headers: h, body: buildForm(req, model, verbose, p.sendPrompt !== false) },
          { provider: p.label, signal: req.signal })
      let body: unknown
      try {
        body = await call(mode !== false)
      } catch (error) {
        // models that only speak plain json refuse verbose_json with a 400
        if (mode !== 'try' || !(error instanceof SttError) || error.status !== 400) throw error
        body = await call(false)
      }
      return parseOpenAiTranscript(body, p.label)
    }
  }
  if (p.modelsPath) {
    const path = p.modelsPath
    provider.listModels = async (cfg: SttConfig, fetch: Fetch, signal?: AbortSignal) => {
      const body = await requestJson(fetch, joinUrl(compatBase(p, cfg), path, p.modelsQuery), { method: 'GET', headers: headers(p, cfg) },
        { provider: p.label, signal })
      const record = asRecord(body)
      // OpenAI style { data: [...] }, Together a bare array
      const entries = Array.isArray(body) ? asArray(body) : asArray(record.data ?? record.models)
      const filter = p.modelFilter ?? defaultFilter(p)
      return dedupeModels(entries.map(filter).filter((m): m is SttModel => !!m))
    }
  }
  const testPath = p.testPath ?? p.modelsPath
  if (testPath) {
    provider.test = (cfg, fetch, signal) =>
      testWith(
        () => requestOk(fetch, joinUrl(compatBase(p, cfg), testPath, testPath === p.modelsPath ? p.modelsQuery : undefined),
          { method: 'GET', headers: headers(p, cfg) }, { provider: p.label, signal }),
        p.kind === 'local-server' ? `${p.label} is answering.` : `Connected to ${p.label}.`
      )
  }
  return provider
}

function defaultFilter(p: CompatPreset) {
  return (entry: Record<string, unknown>): SttModel | undefined => {
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!id) return undefined
    const known = p.staticModels.find((m) => m.id === id)
    if (known) return known
    return { id, label: typeof entry.name === 'string' && entry.name ? entry.name : id, wordTimestamps: p.verbose(id) !== false }
  }
}

const transcribing = /whisper|transcribe|parakeet|canary|voxtral|asr|stt/i

// ---------- presets ----------

export const openai = createCompatProvider({
  id: 'openai',
  label: 'OpenAI',
  kind: 'api',
  docsUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  baseUrl: 'https://api.openai.com/v1',
  keyRequired: true,
  defaultModel: 'whisper-1',
  staticModels: [
    { id: 'whisper-1', label: 'Whisper', wordTimestamps: true, languages: 'multi' },
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', wordTimestamps: false, languages: 'multi', note: 'Text only, word times are aligned on this computer.' },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', wordTimestamps: false, languages: 'multi', note: 'Text only, word times are aligned on this computer.' }
  ],
  // only whisper-1 has verbose_json and word times; the gpt-4o family answers json text only
  verbose: (model) => model.startsWith('whisper'),
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    // diarize needs a chunking strategy and returns a different shape, realtime is websocket only
    if (!/^(whisper|gpt-[\w.-]*transcribe)/.test(id) || /diarize|realtime/.test(id)) return undefined
    return openai.staticModels.find((m) => m.id === id) ?? { id, label: id, wordTimestamps: id.startsWith('whisper'), languages: 'multi' }
  }
})

export const groq = createCompatProvider({
  id: 'groq',
  label: 'Groq',
  kind: 'api',
  docsUrl: 'https://console.groq.com/docs/speech-to-text',
  baseUrl: 'https://api.groq.com/openai/v1',
  keyRequired: true,
  defaultModel: 'whisper-large-v3-turbo',
  // distil-whisper-large-v3-en is no longer listed in Groq's docs
  staticModels: [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', wordTimestamps: true, languages: 'multi' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3', wordTimestamps: true, languages: 'multi' }
  ],
  verbose: () => true,
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!/whisper/i.test(id) || entry.active === false) return undefined
    return groq.staticModels.find((m) => m.id === id) ?? { id, label: id, wordTimestamps: true, languages: /-en$/.test(id) ? 'en' : 'multi' }
  }
})

export const together = createCompatProvider({
  id: 'together',
  label: 'Together AI',
  kind: 'api',
  docsUrl: 'https://docs.together.ai/reference/audio-transcriptions',
  baseUrl: 'https://api.together.ai/v1',
  keyRequired: true,
  defaultModel: 'openai/whisper-large-v3',
  staticModels: [
    { id: 'openai/whisper-large-v3', label: 'Whisper Large v3', wordTimestamps: true, languages: 'multi' },
    { id: 'nvidia/parakeet-tdt-0.6b-v3', label: 'Parakeet TDT 0.6B v3', wordTimestamps: true, languages: 'multi' }
  ],
  verbose: () => 'try',
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!id || (entry.type !== 'transcribe' && !/whisper/i.test(id))) return undefined
    return together.staticModels.find((m) => m.id === id)
      ?? { id, label: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : id, wordTimestamps: true }
  }
})

export const openrouter = createCompatProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'api',
  docsUrl: 'https://openrouter.ai/docs/guides/overview/multimodal/stt',
  baseUrl: 'https://openrouter.ai/api/v1',
  keyRequired: true,
  defaultModel: 'openai/whisper-1',
  staticModels: [
    { id: 'openai/whisper-1', label: 'OpenAI Whisper', wordTimestamps: true, languages: 'multi' },
    { id: 'openai/whisper-large-v3', label: 'Whisper Large v3', wordTimestamps: true, languages: 'multi' },
    { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe', wordTimestamps: false, languages: 'multi', note: 'Text only, word times are aligned on this computer.' }
  ],
  // gpt-4o-transcribe and mai-transcribe refuse verbose_json; others depend on the routed provider
  verbose: (model) => (/gpt-4o|mai-transcribe/.test(model) ? false : 'try'),
  modelsPath: '/models',
  modelsQuery: { output_modalities: 'transcription' },
  // GET /models is public, /key needs a valid key
  testPath: '/key',
  // OpenRouter accepts prompt but ignores it
  sendPrompt: false
})

export const openaiCompatible = createCompatProvider({
  id: 'openai-compatible',
  label: 'OpenAI-compatible API',
  kind: 'api',
  docsUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  keyRequired: false,
  defaultModel: 'whisper-1',
  staticModels: [],
  verbose: () => 'try',
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    return id && transcribing.test(id) ? { id, label: id, wordTimestamps: true } : undefined
  }
})

export const fireworks = createCompatProvider({
  id: 'fireworks',
  label: 'Fireworks AI',
  kind: 'api',
  docsUrl: 'https://docs.fireworks.ai/api-reference/audio-transcriptions',
  baseUrl: 'https://audio-prod.us-virginia-1.direct.fireworks.ai/v1',
  baseUrlFor: (model) => (model === 'whisper-v3-turbo' ? 'https://audio-turbo.us-virginia-1.direct.fireworks.ai/v1' : undefined),
  keyRequired: true,
  defaultModel: 'whisper-v3-turbo',
  staticModels: [
    { id: 'whisper-v3-turbo', label: 'Whisper v3 Turbo', wordTimestamps: true, languages: 'multi' },
    { id: 'whisper-v3', label: 'Whisper v3', wordTimestamps: true, languages: 'multi' }
  ],
  // the audio hosts have no model list or key check, a dictation is the test
  verbose: () => true
})

// ---------- servers on this computer ----------

export const speaches = createCompatProvider({
  id: 'speaches',
  label: 'Speaches (faster-whisper-server)',
  kind: 'local-server',
  docsUrl: 'https://speaches.ai/usage/speech-to-text/',
  defaultBaseUrl: 'http://127.0.0.1:8000/v1',
  keyRequired: false,
  defaultModel: 'Systran/faster-whisper-small',
  staticModels: [
    { id: 'Systran/faster-whisper-small', label: 'faster-whisper small', wordTimestamps: true, languages: 'multi' },
    { id: 'Systran/faster-distil-whisper-small.en', label: 'faster-distil-whisper small.en', wordTimestamps: true, languages: 'en' }
  ],
  verbose: () => true,
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    // speaches also lists its text-to-speech voices
    if (!id || (typeof entry.task === 'string' && entry.task !== 'automatic-speech-recognition')) return undefined
    return { id, label: id, wordTimestamps: true, languages: /\.en$/.test(id) ? 'en' : 'multi' }
  }
})

export const localai = createCompatProvider({
  id: 'localai',
  label: 'LocalAI',
  kind: 'local-server',
  docsUrl: 'https://localai.io/docs/features/audio-to-text/',
  defaultBaseUrl: 'http://127.0.0.1:8080/v1',
  keyRequired: false,
  defaultModel: 'whisper-1',
  staticModels: [{ id: 'whisper-1', label: 'whisper-1 (as named in your LocalAI config)', wordTimestamps: false, languages: 'multi' }],
  // the whisper backend only has segment times, other backends honor word
  verbose: () => true,
  modelsPath: '/models',
  modelFilter(entry) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    return id ? { id, label: id, wordTimestamps: false } : undefined
  }
})

export const localOpenAiCompatible = createCompatProvider({
  id: 'local-openai-compatible',
  label: 'OpenAI-compatible local server',
  kind: 'local-server',
  docsUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  defaultBaseUrl: 'http://127.0.0.1:8080/v1',
  keyRequired: false,
  defaultModel: 'whisper-1',
  staticModels: [],
  verbose: () => 'try',
  modelsPath: '/models'
})
