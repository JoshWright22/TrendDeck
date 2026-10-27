// Speechmatics batch transcription: create a job, poll it, fetch the transcript.
//   https://docs.speechmatics.com/api-ref/batch/create-a-new-job
//   https://docs.speechmatics.com/api-ref/batch/get-the-transcript-for-a-transcription-job
// POST /v2/jobs (multipart: data_file, config = { type: 'transcription', transcription_config }) with
// Authorization: Bearer <key> -> { id }. GET /v2/jobs/{id} until job.status is done or rejected.
// GET /v2/jobs/{id}/transcript?format=json-v2 -> results: [{ type: word | punctuation, start_time,
// end_time, attaches_to, alternatives: [{ content, language }] }] in seconds
import {
  SttError, asArray, asRecord, audioMime, checkAudio, defaultPollDeps, field, jobId, languageCode, modelId, poll, requestJson,
  requestOk, secret, testWith, type PollDeps
} from './http'
import { attachToPrevious, joinWords, result, word } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Speechmatics'
const HOSTS: Record<string, string> = { eu: 'eu1.asr.api.speechmatics.com', us: 'us1.asr.api.speechmatics.com' }

const fields: SttField[] = [
  { key: 'apiKey', label: 'API key', secret: true, required: true },
  { key: 'region', label: 'Region', secret: false, required: false, kind: 'select', options: Object.keys(HOSTS), defaultValue: 'eu' }
]

function host(cfg: SttConfig): string {
  const h = HOSTS[field(cfg, 'region', fields)]
  if (!h) throw new SttError('Choose a Speechmatics region.')
  return h
}

function auth(cfg: SttConfig): Record<string, string> {
  return { Authorization: `Bearer ${secret(cfg, 'apiKey')}` }
}

export function speechmaticsConfig(model: string, language: string): Record<string, unknown> {
  return {
    type: 'transcription',
    transcription_config: { language: language ? language.split('-')[0] : 'auto', operating_point: model }
  }
}

export function parseSpeechmatics(body: unknown): SttResult {
  const b = asRecord(body)
  if (!Array.isArray(b.results)) throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  let language: string | undefined
  for (const r of asArray(b.results)) {
    const alt = asArray(r.alternatives)[0]
    const content = typeof alt?.content === 'string' ? alt.content : ''
    if (!content) continue
    if (!language && typeof alt?.language === 'string') language = alt.language
    if (r.type === 'punctuation') {
      attachToPrevious(words, content)
      continue
    }
    const parsed = word(content, r.start_time, r.end_time)
    if (parsed) words.push(parsed)
  }
  const meta = asRecord(asRecord(b.metadata).language_identification)
  return result(joinWords(words), words, [], language ?? (typeof meta.predicted_language === 'string' ? meta.predicted_language : undefined))
}

export function createSpeechmatics(deps: PollDeps = defaultPollDeps): SttProvider {
  return {
    id: 'speechmatics',
    label: LABEL,
    kind: 'api',
    fields,
    defaultModel: 'enhanced',
    staticModels: [
      { id: 'enhanced', label: 'Enhanced', wordTimestamps: true, languages: 'multi', note: 'Most accurate.' },
      { id: 'standard', label: 'Standard', wordTimestamps: true, languages: 'multi', note: 'Faster and cheaper.' }
    ],
    supportsWordTimestamps: true,
    supportsStreaming: false,
    docsUrl: 'https://docs.speechmatics.com/api-ref/batch/create-a-new-job',
    host(cfg) {
      try {
        return host(cfg)
      } catch {
        return ''
      }
    },
    async transcribe(req, cfg, fetch) {
      const audio = checkAudio(req.audio)
      const model = modelId(req.model, 'enhanced')
      if (model !== 'enhanced' && model !== 'standard') throw new SttError('Choose Enhanced or Standard.')
      const { mime, extension } = audioMime(req.mimeType)
      const base = `https://${host(cfg)}/v2`
      const opts = { provider: LABEL, signal: req.signal }
      const form = new FormData()
      form.append('data_file', new Blob([audio], { type: mime }), `audio.${extension}`)
      form.append('config', JSON.stringify(speechmaticsConfig(model, languageCode(req.language))))
      const created = asRecord(await requestJson(fetch, `${base}/jobs`, { method: 'POST', headers: auth(cfg), body: form }, opts))
      const id = jobId(created.id, LABEL)
      await poll(async () => {
        const job = asRecord(asRecord(await requestJson(fetch, `${base}/jobs/${id}`, { method: 'GET', headers: auth(cfg) }, opts)).job)
        if (job.status === 'done') return true
        if (job.status === 'rejected' || job.status === 'deleted' || job.status === 'expired') {
          throw new SttError(`${LABEL} could not transcribe the audio.`)
        }
        return undefined
      }, { provider: LABEL, signal: req.signal, deps })
      const body = await requestJson(fetch, `${base}/jobs/${id}/transcript?format=json-v2`, { method: 'GET', headers: auth(cfg) }, opts)
      return parseSpeechmatics(body)
    },
    test(cfg, fetch, signal) {
      return testWith(() => requestOk(fetch, `https://${host(cfg)}/v2/jobs?limit=1`, { method: 'GET', headers: auth(cfg) },
        { provider: LABEL, signal }), 'Connected to Speechmatics.')
    }
  }
}

export const speechmatics = createSpeechmatics()
