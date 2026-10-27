// AssemblyAI pre-recorded transcription: upload, create, poll.
//   https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file
//   https://www.assemblyai.com/docs/api-reference/transcripts/submit
//   https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model
// POST /v2/upload (raw bytes, header authorization: <key>, no Bearer) -> { upload_url }
// POST /v2/transcript { audio_url, speech_models: [...], language_code | language_detection } -> { id }
// GET /v2/transcript/{id} until status is completed or error; words: [{ text, start, end }] in ms.
// speech_model (singular) is deprecated; universal-3-5-pro and universal-2 are the current models
import {
  SttError, asArray, asRecord, checkAudio, defaultPollDeps, field, jobId, languageCode, modelId, poll, requestJson,
  requestOk, secret, testWith, type PollDeps
} from './http'
import { result, word } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'AssemblyAI'
const HOSTS: Record<string, string> = { us: 'api.assemblyai.com', eu: 'api.eu.assemblyai.com' }

const fields: SttField[] = [
  { key: 'apiKey', label: 'API key', secret: true, required: true },
  { key: 'region', label: 'Region', secret: false, required: false, kind: 'select', options: Object.keys(HOSTS), defaultValue: 'us' }
]

function host(cfg: SttConfig): string {
  const h = HOSTS[field(cfg, 'region', fields)]
  if (!h) throw new SttError('Choose an AssemblyAI region.')
  return h
}

function auth(cfg: SttConfig): Record<string, string> {
  return { authorization: secret(cfg, 'apiKey') }
}

export function parseAssemblyAi(body: Record<string, unknown>): SttResult {
  if (typeof body.text !== 'string' && body.text !== null) throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const w of asArray(body.words)) {
    const parsed = word(w.text, w.start, w.end, 1 / 1000)
    if (parsed) words.push(parsed)
  }
  return result(typeof body.text === 'string' ? body.text : '', words, [], typeof body.language_code === 'string' ? body.language_code : undefined)
}

export function createAssemblyAi(deps: PollDeps = defaultPollDeps): SttProvider {
  return {
    id: 'assemblyai',
    label: LABEL,
    kind: 'api',
    fields,
    defaultModel: 'universal-3-5-pro',
    staticModels: [
      { id: 'universal-3-5-pro', label: 'Universal-3.5 Pro', wordTimestamps: true, languages: 'multi', note: '18 languages, others fall back to Universal-2.' },
      { id: 'universal-2', label: 'Universal-2', wordTimestamps: true, languages: 'multi', note: '99 languages, lower cost.' }
    ],
    supportsWordTimestamps: true,
    supportsStreaming: false,
    docsUrl: 'https://www.assemblyai.com/docs/api-reference/transcripts/submit',
    host(cfg) {
      try {
        return host(cfg)
      } catch {
        return ''
      }
    },
    async transcribe(req, cfg, fetch) {
      const audio = checkAudio(req.audio)
      const model = modelId(req.model, 'universal-3-5-pro')
      const language = languageCode(req.language)
      const base = `https://${host(cfg)}/v2`
      const opts = { provider: LABEL, signal: req.signal }
      const uploaded = asRecord(await requestJson(fetch, `${base}/upload`, {
        method: 'POST', headers: { ...auth(cfg), 'Content-Type': 'application/octet-stream' }, body: audio
      }, opts))
      if (typeof uploaded.upload_url !== 'string' || !uploaded.upload_url.startsWith('https://')) {
        throw new SttError(`${LABEL} returned an unreadable response.`)
      }
      const created = asRecord(await requestJson(fetch, `${base}/transcript`, {
        method: 'POST',
        headers: { ...auth(cfg), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploaded.upload_url,
          speech_models: [model],
          ...(language ? { language_code: language } : { language_detection: true }),
          punctuate: true,
          format_text: true
        })
      }, opts))
      const id = jobId(created.id, LABEL)
      const done = await poll(async () => {
        const t = asRecord(await requestJson(fetch, `${base}/transcript/${id}`, { method: 'GET', headers: auth(cfg) }, opts))
        if (t.status === 'completed') return t
        // t.error is the provider's own text, kept out of the message
        if (t.status === 'error') throw new SttError(`${LABEL} could not transcribe the audio.`)
        return undefined
      }, { provider: LABEL, signal: req.signal, deps })
      return parseAssemblyAi(done)
    },
    test(cfg, fetch, signal) {
      return testWith(() => requestOk(fetch, `https://${host(cfg)}/v2/transcript?limit=1`, { method: 'GET', headers: auth(cfg) },
        { provider: LABEL, signal }), 'Connected to AssemblyAI.')
    }
  }
}

export const assemblyai = createAssemblyAi()
