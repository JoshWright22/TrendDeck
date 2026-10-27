// Gladia pre-recorded transcription (v2): upload, create, poll.
//   https://docs.gladia.io/api-reference/v2/upload/audio-file
//   https://docs.gladia.io/api-reference/v2/pre-recorded/init
//   https://docs.gladia.io/api-reference/v2/pre-recorded/get
// POST /v2/upload (multipart: audio) with x-gladia-key -> { audio_url }. POST /v2/pre-recorded
// { audio_url, language_config } -> { id }. GET /v2/pre-recorded/{id} until status is done or error;
// result.transcription: { full_transcript, languages, utterances: [{ words: [{ word, start, end }] }] }
import {
  SttError, asArray, asRecord, audioMime, checkAudio, defaultPollDeps, jobId, languageCode, poll, requestJson, requestOk,
  secret, testWith, type PollDeps
} from './http'
import { result, word } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Gladia'
const HOST = 'api.gladia.io'

const fields: SttField[] = [{ key: 'apiKey', label: 'API key', secret: true, required: true }]

function auth(cfg: SttConfig): Record<string, string> {
  return { 'x-gladia-key': secret(cfg, 'apiKey') }
}

export function gladiaBody(audioUrl: string, language: string): Record<string, unknown> {
  return {
    audio_url: audioUrl,
    language_config: language ? { languages: [language.split('-')[0]], code_switching: false } : { languages: [], code_switching: false }
  }
}

export function parseGladia(body: unknown): SttResult {
  const transcription = asRecord(asRecord(asRecord(body).result).transcription)
  if (typeof transcription.full_transcript !== 'string') throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  for (const u of asArray(transcription.utterances)) {
    for (const w of asArray(u.words)) {
      const parsed = word(w.word, w.start, w.end)
      if (parsed) words.push(parsed)
    }
  }
  const languages = Array.isArray(transcription.languages) ? transcription.languages : []
  return result(transcription.full_transcript, words, [], typeof languages[0] === 'string' ? languages[0] : undefined)
}

export function createGladia(deps: PollDeps = defaultPollDeps): SttProvider {
  return {
    id: 'gladia',
    label: LABEL,
    kind: 'api',
    fields,
    defaultModel: 'solaria-1',
    staticModels: [{ id: 'solaria-1', label: 'Solaria', wordTimestamps: true, languages: 'multi' }],
    supportsWordTimestamps: true,
    supportsStreaming: false,
    docsUrl: 'https://docs.gladia.io/api-reference/v2/pre-recorded/init',
    host: () => HOST,
    async transcribe(req, cfg, fetch) {
      const audio = checkAudio(req.audio)
      const language = languageCode(req.language)
      const { mime, extension } = audioMime(req.mimeType)
      const base = `https://${HOST}/v2`
      const opts = { provider: LABEL, signal: req.signal }
      const form = new FormData()
      form.append('audio', new Blob([audio], { type: mime }), `audio.${extension}`)
      const uploaded = asRecord(await requestJson(fetch, `${base}/upload`, { method: 'POST', headers: auth(cfg), body: form }, opts))
      if (typeof uploaded.audio_url !== 'string' || !uploaded.audio_url.startsWith('https://')) {
        throw new SttError(`${LABEL} returned an unreadable response.`)
      }
      const created = asRecord(await requestJson(fetch, `${base}/pre-recorded`, {
        method: 'POST', headers: { ...auth(cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(gladiaBody(uploaded.audio_url, language))
      }, opts))
      const id = jobId(created.id, LABEL)
      const done = await poll(async () => {
        const job = asRecord(await requestJson(fetch, `${base}/pre-recorded/${id}`, { method: 'GET', headers: auth(cfg) }, opts))
        if (job.status === 'done') return job
        if (job.status === 'error') throw new SttError(`${LABEL} could not transcribe the audio.`)
        return undefined
      }, { provider: LABEL, signal: req.signal, deps })
      return parseGladia(done)
    },
    test(cfg, fetch, signal) {
      return testWith(() => requestOk(fetch, `https://${HOST}/v2/pre-recorded?limit=1`, { method: 'GET', headers: auth(cfg) },
        { provider: LABEL, signal }), 'Connected to Gladia.')
    }
  }
}

export const gladia = createGladia()
