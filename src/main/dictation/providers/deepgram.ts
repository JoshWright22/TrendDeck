// Deepgram pre-recorded speech-to-text.
//   https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
//   https://developers.deepgram.com/reference/models/list-models  (GET /v1/models)
// POST /v1/listen?model=nova-3&smart_format=true&punctuate=true with the raw audio as the body and
// Authorization: Token <key>. results.channels[0].alternatives[0] has transcript and
// words: [{ word, punctuated_word, start, end }] in seconds
import {
  SttError, asArray, asRecord, checkAudio, audioMime, field, languageCode, modelId, requestJson, requestOk, secret, testWith,
  dedupeModels
} from './http'
import { result, word } from './timing'
import type { SttConfig, SttField, SttModel, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Deepgram'
const HOSTS: Record<string, string> = { us: 'api.deepgram.com', eu: 'api.eu.deepgram.com' }

const fields: SttField[] = [
  { key: 'apiKey', label: 'API key', secret: true, required: true },
  { key: 'region', label: 'Region', secret: false, required: false, kind: 'select', options: Object.keys(HOSTS), defaultValue: 'us' }
]

function host(cfg: SttConfig): string {
  const region = field(cfg, 'region', fields)
  const h = HOSTS[region]
  if (!h) throw new SttError('Choose a Deepgram region.')
  return h
}

function auth(cfg: SttConfig): Record<string, string> {
  return { Authorization: `Token ${secret(cfg, 'apiKey')}` }
}

const MODELS: SttModel[] = [
  { id: 'nova-3', label: 'Nova-3', wordTimestamps: true, languages: 'multi' },
  { id: 'nova-3-medical', label: 'Nova-3 Medical', wordTimestamps: true, languages: 'en' },
  { id: 'nova-2', label: 'Nova-2', wordTimestamps: true, languages: 'multi' }
]

export function deepgramUrl(cfg: SttConfig, model: string, language: string): string {
  const url = new URL(`https://${host(cfg)}/v1/listen`)
  url.searchParams.set('model', model)
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  if (language) url.searchParams.set('language', language)
  else url.searchParams.set('detect_language', 'true')
  return url.toString()
}

export function parseDeepgram(body: unknown): SttResult {
  const channel = asArray(asRecord(asRecord(body).results).channels)[0]
  const alt = asArray(channel?.alternatives)[0]
  if (!alt || typeof alt.transcript !== 'string') throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const w of asArray(alt.words)) {
    const parsed = word(typeof w.punctuated_word === 'string' && w.punctuated_word ? w.punctuated_word : w.word, w.start, w.end)
    if (parsed) words.push(parsed)
  }
  return result(alt.transcript, words, [], typeof channel?.detected_language === 'string' ? channel.detected_language : undefined)
}

export const deepgram: SttProvider = {
  id: 'deepgram',
  label: LABEL,
  kind: 'api',
  fields,
  defaultModel: 'nova-3',
  staticModels: MODELS,
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded',
  host(cfg) {
    try {
      return host(cfg)
    } catch {
      return ''
    }
  },
  async transcribe(req, cfg, fetch) {
    const audio = checkAudio(req.audio)
    const url = deepgramUrl(cfg, modelId(req.model, 'nova-3'), languageCode(req.language))
    const body = await requestJson(fetch, url, {
      method: 'POST',
      headers: { ...auth(cfg), 'Content-Type': audioMime(req.mimeType).mime },
      body: audio
    }, { provider: LABEL, signal: req.signal })
    return parseDeepgram(body)
  },
  async listModels(cfg, fetch, signal) {
    const body = await requestJson(fetch, `https://${host(cfg)}/v1/models`, { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal })
    const out: SttModel[] = []
    for (const m of asArray(asRecord(body).stt)) {
      const id = typeof m.canonical_name === 'string' ? m.canonical_name : ''
      if (!id || m.batch === false || !/^[\w.-]+$/.test(id)) continue
      const known = MODELS.find((k) => k.id === id)
      const langs = Array.isArray(m.languages) ? m.languages : []
      out.push(known ?? {
        id, label: typeof m.name === 'string' && m.name ? `${m.name} (${id})` : id, wordTimestamps: true,
        languages: langs.length === 1 && String(langs[0]).startsWith('en') ? 'en' : 'multi'
      })
    }
    return dedupeModels(out)
  },
  test(cfg, fetch, signal) {
    // lists the key's projects: needs a valid key, sends no audio
    return testWith(() => requestOk(fetch, `https://${host(cfg)}/v1/projects`, { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal }),
      'Connected to Deepgram.')
  }
}
