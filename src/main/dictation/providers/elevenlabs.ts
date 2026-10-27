// ElevenLabs Scribe speech-to-text.
//   https://elevenlabs.io/docs/api-reference/speech-to-text/convert
// POST /v1/speech-to-text, multipart: model_id (scribe_v2, scribe_v1), file, language_code,
// timestamps_granularity=word, tag_audio_events. header xi-api-key.
// answer { text, language_code, words: [{ text, start, end, type: word | spacing | audio_event }] }
import {
  SttError, asArray, asRecord, audioMime, checkAudio, field, languageCode, modelId, requestJson, requestOk, secret, testWith
} from './http'
import { result, word } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'ElevenLabs'
const HOSTS: Record<string, string> = { default: 'api.elevenlabs.io', us: 'api.us.elevenlabs.io' }

const fields: SttField[] = [
  { key: 'apiKey', label: 'API key', secret: true, required: true },
  { key: 'region', label: 'Server', secret: false, required: false, kind: 'select', options: Object.keys(HOSTS), defaultValue: 'default' }
]

function host(cfg: SttConfig): string {
  const h = HOSTS[field(cfg, 'region', fields)]
  if (!h) throw new SttError('Choose an ElevenLabs server.')
  return h
}

function auth(cfg: SttConfig): Record<string, string> {
  return { 'xi-api-key': secret(cfg, 'apiKey') }
}

export function parseElevenLabs(body: unknown): SttResult {
  const b = asRecord(body)
  if (typeof b.text !== 'string') throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const w of asArray(b.words)) {
    // spacing tokens are the gaps between words, audio events are "(laughter)" and the like
    if (w.type !== undefined && w.type !== 'word') continue
    const parsed = word(w.text, w.start, w.end)
    if (parsed) words.push(parsed)
  }
  return result(b.text, words, [], typeof b.language_code === 'string' ? b.language_code : undefined)
}

export const elevenlabs: SttProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  kind: 'api',
  fields,
  defaultModel: 'scribe_v2',
  staticModels: [
    { id: 'scribe_v2', label: 'Scribe v2', wordTimestamps: true, languages: 'multi' },
    { id: 'scribe_v1', label: 'Scribe v1', wordTimestamps: true, languages: 'multi' }
  ],
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text/convert',
  host(cfg) {
    try {
      return host(cfg)
    } catch {
      return ''
    }
  },
  async transcribe(req, cfg, fetch) {
    const audio = checkAudio(req.audio)
    const { mime, extension } = audioMime(req.mimeType)
    const language = languageCode(req.language)
    const form = new FormData()
    form.append('model_id', modelId(req.model, 'scribe_v2'))
    form.append('file', new Blob([audio], { type: mime }), `audio.${extension}`)
    if (language) form.append('language_code', language)
    form.append('timestamps_granularity', 'word')
    form.append('tag_audio_events', 'false')
    form.append('diarize', 'false')
    const body = await requestJson(fetch, `https://${host(cfg)}/v1/speech-to-text`, { method: 'POST', headers: auth(cfg), body: form },
      { provider: LABEL, signal: req.signal })
    return parseElevenLabs(body)
  },
  test(cfg, fetch, signal) {
    return testWith(() => requestOk(fetch, `https://${host(cfg)}/v1/models`, { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal }),
      'Connected to ElevenLabs.')
  }
}
