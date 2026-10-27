// Mistral Voxtral transcription.
//   https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription
//   https://docs.mistral.ai/models/voxtral-mini-transcribe-26-02
// POST https://api.mistral.ai/v1/audio/transcriptions, header x-api-key, multipart: file, model,
// language, timestamp_granularities (segment | word). per the docs timestamp_granularities "is
// currently not compatible with language", so a set language means no times (aligned locally).
// answer { model, text, language, segments: [{ text, start, end, type }] }
import {
  SttError, asArray, asRecord, audioMime, checkAudio, dedupeModels, languageCode, modelId, requestJson, requestOk, secret,
  testWith
} from './http'
import { result, word, type TimedSegment } from './timing'
import type { SttConfig, SttModel, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Mistral'
const BASE = 'https://api.mistral.ai/v1'

const MODELS: SttModel[] = [
  { id: 'voxtral-mini-latest', label: 'Voxtral Mini Transcribe 2', wordTimestamps: true, languages: 'multi' },
  { id: 'voxtral-mini-transcribe-latest', label: 'Voxtral Mini Transcribe 3 (preview)', wordTimestamps: true, languages: 'multi' },
  { id: 'voxtral-small-transcribe-latest', label: 'Voxtral Small Transcribe 3 (preview)', wordTimestamps: true, languages: 'multi' }
]

function auth(cfg: SttConfig): Record<string, string> {
  return { 'x-api-key': secret(cfg, 'apiKey') }
}

// with word granularity each segment is one word; anything longer is spread
export function parseMistral(body: unknown): SttResult {
  const b = asRecord(body)
  if (typeof b.text !== 'string') throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const w of asArray(b.words)) {
    const parsed = word(w.word ?? w.text, w.start, w.end)
    if (parsed) words.push(parsed)
  }
  const segments: TimedSegment[] = []
  for (const s of asArray(b.segments)) {
    if (typeof s.text === 'string' && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end))) {
      segments.push({ text: s.text, start: Number(s.start), end: Number(s.end) })
    }
  }
  if (!words.length && segments.length && segments.every((s) => s.text.trim().split(/\s+/).length <= 1)) {
    for (const s of segments) {
      const parsed = word(s.text, s.start, s.end)
      if (parsed) words.push(parsed)
    }
  }
  return result(b.text, words, segments, typeof b.language === 'string' ? b.language : undefined)
}

export const mistral: SttProvider = {
  id: 'mistral',
  label: 'Mistral Voxtral',
  kind: 'api',
  fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }],
  defaultModel: 'voxtral-mini-latest',
  staticModels: MODELS,
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription',
  host: () => 'api.mistral.ai',
  async transcribe(req, cfg, fetch) {
    const audio = checkAudio(req.audio)
    const { mime, extension } = audioMime(req.mimeType)
    const language = languageCode(req.language)
    const form = new FormData()
    form.append('model', modelId(req.model, 'voxtral-mini-latest'))
    form.append('file', new Blob([audio], { type: mime }), `audio.${extension}`)
    if (language) form.append('language', language)
    else form.append('timestamp_granularities', 'word')
    const body = await requestJson(fetch, `${BASE}/audio/transcriptions`, { method: 'POST', headers: auth(cfg), body: form },
      { provider: LABEL, signal: req.signal })
    return parseMistral(body)
  },
  async listModels(cfg, fetch, signal) {
    const body = await requestJson(fetch, `${BASE}/models`, { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal })
    const out: SttModel[] = []
    for (const m of asArray(asRecord(body).data)) {
      const id = typeof m.id === 'string' ? m.id : ''
      const caps = asRecord(m.capabilities)
      const known = MODELS.find((k) => k.id === id)
      if (known) out.push(known)
      else if (id && (caps.audio_transcription === true || /transcribe/.test(id)) && !/realtime/.test(id)) {
        out.push({ id, label: id, wordTimestamps: true, languages: 'multi' })
      }
    }
    return dedupeModels(out)
  },
  test(cfg, fetch, signal) {
    return testWith(() => requestOk(fetch, `${BASE}/models`, { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal }), 'Connected to Mistral.')
  }
}
