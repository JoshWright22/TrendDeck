// Rev.ai asynchronous speech-to-text: submit a job with the file, poll it, fetch the transcript.
//   https://docs.rev.ai/api/asynchronous/reference/#operation/SubmitTranscriptionJob
//   https://docs.rev.ai/api/asynchronous/reference/#operation/GetTranscriptById
// POST /speechtotext/v1/jobs (multipart: media, options = { transcriber, language }) with
// Authorization: Bearer <token> -> { id, status }. GET /jobs/{id} until status is transcribed or
// failed. GET /jobs/{id}/transcript (Accept: application/vnd.rev.transcript.v1.0+json) ->
// monologues: [{ elements: [{ type: text | punct, value, ts, end_ts }] }] in seconds
import {
  SttError, asArray, asRecord, audioMime, checkAudio, defaultPollDeps, field, jobId, languageCode, modelId, poll, requestJson,
  requestOk, secret, testWith, type PollDeps
} from './http'
import { attachToPrevious, joinWords, result, word } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Rev.ai'
const HOSTS: Record<string, string> = { us: 'api.rev.ai', eu: 'ec1.api.rev.ai' }

const fields: SttField[] = [
  { key: 'apiKey', label: 'Access token', secret: true, required: true },
  { key: 'region', label: 'Region', secret: false, required: false, kind: 'select', options: Object.keys(HOSTS), defaultValue: 'us' }
]

function host(cfg: SttConfig): string {
  const h = HOSTS[field(cfg, 'region', fields)]
  if (!h) throw new SttError('Choose a Rev.ai region.')
  return h
}

function auth(cfg: SttConfig): Record<string, string> {
  return { Authorization: `Bearer ${secret(cfg, 'apiKey')}` }
}

export function parseRevAi(body: unknown): SttResult {
  const b = asRecord(body)
  if (!Array.isArray(b.monologues)) throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const m of asArray(b.monologues)) {
    for (const e of asArray(m.elements)) {
      const value = typeof e.value === 'string' ? e.value : ''
      if (e.type === 'punct') {
        if (value.trim()) attachToPrevious(words, value.trim())
        continue
      }
      if (e.type !== 'text') continue
      const parsed = word(value, e.ts, e.end_ts)
      if (parsed) words.push(parsed)
    }
  }
  return result(joinWords(words), words, [])
}

export function createRevAi(deps: PollDeps = defaultPollDeps): SttProvider {
  return {
    id: 'revai',
    label: LABEL,
    kind: 'api',
    fields,
    defaultModel: 'machine',
    staticModels: [
      { id: 'machine', label: 'Reverb', wordTimestamps: true, languages: 'multi' },
      { id: 'low_cost', label: 'Reverb Turbo', wordTimestamps: true, languages: 'multi', note: 'Cheaper, a little less accurate.' }
    ],
    supportsWordTimestamps: true,
    supportsStreaming: false,
    docsUrl: 'https://docs.rev.ai/api/asynchronous/reference/',
    host(cfg) {
      try {
        return host(cfg)
      } catch {
        return ''
      }
    },
    async transcribe(req, cfg, fetch) {
      const audio = checkAudio(req.audio)
      const model = modelId(req.model, 'machine')
      const language = languageCode(req.language)
      const { mime, extension } = audioMime(req.mimeType)
      const base = `https://${host(cfg)}/speechtotext/v1`
      const opts = { provider: LABEL, signal: req.signal }
      const form = new FormData()
      form.append('media', new Blob([audio], { type: mime }), `audio.${extension}`)
      form.append('options', JSON.stringify({ transcriber: model, ...(language ? { language: language.split('-')[0] } : {}) }))
      const created = asRecord(await requestJson(fetch, `${base}/jobs`, { method: 'POST', headers: auth(cfg), body: form }, opts))
      const id = jobId(created.id, LABEL)
      await poll(async () => {
        const job = asRecord(await requestJson(fetch, `${base}/jobs/${id}`, { method: 'GET', headers: auth(cfg) }, opts))
        if (job.status === 'transcribed') return true
        if (job.status === 'failed') throw new SttError(`${LABEL} could not transcribe the audio.`)
        return undefined
      }, { provider: LABEL, signal: req.signal, deps })
      const body = await requestJson(fetch, `${base}/jobs/${id}/transcript`, {
        method: 'GET', headers: { ...auth(cfg), Accept: 'application/vnd.rev.transcript.v1.0+json' }
      }, opts)
      return parseRevAi(body)
    },
    test(cfg, fetch, signal) {
      return testWith(() => requestOk(fetch, `https://${host(cfg)}/speechtotext/v1/account`, { method: 'GET', headers: auth(cfg) },
        { provider: LABEL, signal }), 'Connected to Rev.ai.')
    }
  }
}

export const revai = createRevAi()
