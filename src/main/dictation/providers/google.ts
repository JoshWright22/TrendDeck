// Google Cloud Speech-to-Text v2, synchronous recognize.
//   https://cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/recognize
//   https://cloud.google.com/speech-to-text/v2/docs/sync-recognize   (inline audio: < 60 s, 10 MB)
//   https://cloud.google.com/speech-to-text/v2/quotas
//   https://cloud.google.com/docs/authentication/api-keys-use       (x-goog-api-key header)
// POST https://{host}/v2/projects/{project}/locations/{location}/recognizers/{recognizer}:recognize
// with { config: { autoDecodingConfig, model, languageCodes, features: { enableWordTimeOffsets } },
// content: base64 }. host is speech.googleapis.com for global, {location}-speech.googleapis.com otherwise.
// results[].alternatives[0].words[] = { word, startOffset: "1.500s", endOffset }.
// the API key goes in the x-goog-api-key header, never in the url
import {
  SttError, asArray, asRecord, checkAudio, field, languageCode, modelId, requestJson, requestOk, secret, slug, testWith
} from './http'
import { duration, result, wavSeconds, word, type TimedSegment } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Google Cloud Speech-to-Text'
export const GOOGLE_INLINE_SECONDS = 60
export const GOOGLE_INLINE_BYTES = 10 * 1024 * 1024

const fields: SttField[] = [
  { key: 'apiKey', label: 'API key', secret: true, required: false, placeholder: 'Or use an access token below' },
  { key: 'accessToken', label: 'OAuth access token (optional)', secret: true, required: false },
  { key: 'project', label: 'Project ID', secret: false, required: true, placeholder: 'my-project' },
  { key: 'location', label: 'Location', secret: false, required: false, placeholder: 'global', defaultValue: 'global' },
  { key: 'recognizer', label: 'Recognizer', secret: false, required: false, placeholder: '_', defaultValue: '_' }
]

interface Target {
  host: string
  location: string
  path: string
}

function target(cfg: SttConfig): Target {
  const project = slug(field(cfg, 'project', fields), 'Google Cloud project ID', /^[a-z0-9][a-z0-9-]{0,62}$/)
  const location = slug(field(cfg, 'location', fields), 'Google Cloud location')
  const recognizer = slug(field(cfg, 'recognizer', fields), 'recognizer ID', /^(_|[a-z0-9][a-z0-9-]{0,62})$/)
  return {
    host: location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`,
    location,
    path: `/v2/projects/${project}/locations/${location}/recognizers/${recognizer}`
  }
}

function auth(cfg: SttConfig): Record<string, string> {
  const token = secret(cfg, 'accessToken')
  return token ? { Authorization: `Bearer ${token}` } : { 'x-goog-api-key': secret(cfg, 'apiKey') }
}

// Chirp takes BCP-47 codes; the common ISO 639-1 ones get their usual region
const REGION: Record<string, string> = {
  en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ja: 'ja-JP', ko: 'ko-KR',
  zh: 'cmn-Hans-CN', hi: 'hi-IN', ru: 'ru-RU', pl: 'pl-PL', tr: 'tr-TR', ar: 'ar-EG', sv: 'sv-SE', uk: 'uk-UA', id: 'id-ID'
}

export function googleLanguage(language: string): string {
  if (!language) return 'auto'
  return language.includes('-') ? language : REGION[language] ?? language
}

function base64(audio: ArrayBuffer): string {
  return Buffer.from(audio).toString('base64')
}

export function parseGoogle(body: unknown): SttResult {
  const b = asRecord(body)
  if (!b || typeof b !== 'object') throw new SttError(`${LABEL} returned an unreadable response.`)
  const texts: string[] = []
  const words: SttWord[] = []
  const segments: TimedSegment[] = []
  let exact = true
  let previousEnd = 0
  let language: string | undefined
  for (const r of asArray(b.results)) {
    const alt = asArray(r.alternatives)[0]
    const end = duration(r.resultEndOffset)
    if (!language && typeof r.languageCode === 'string') language = r.languageCode
    if (!alt || typeof alt.transcript !== 'string' || !alt.transcript.trim()) {
      if (end !== undefined) previousEnd = end
      continue
    }
    texts.push(alt.transcript.trim())
    const ws = asArray(alt.words)
    let got = 0
    for (const w of ws) {
      // a missing offset is a zero Duration, left out of the JSON
      const parsed = word(w.word, duration(w.startOffset) ?? 0, duration(w.endOffset) ?? 0)
      if (parsed) {
        words.push(parsed)
        got++
      }
    }
    if (!got) {
      exact = false
      if (end !== undefined) segments.push({ text: alt.transcript, start: previousEnd, end })
    }
    if (end !== undefined) previousEnd = end
  }
  const text = texts.join(' ')
  // some results with words, some without: fall back to segments for all of it
  return exact ? result(text, words, [], language) : result(text, [], segments, language)
}

export const google: SttProvider = {
  id: 'google',
  label: 'Google Cloud Speech-to-Text',
  kind: 'api',
  fields,
  defaultModel: 'chirp_3',
  staticModels: [
    { id: 'chirp_3', label: 'Chirp 3', wordTimestamps: true, languages: 'multi', note: 'Up to 60 seconds per request.' },
    { id: 'chirp_2', label: 'Chirp 2', wordTimestamps: true, languages: 'multi', note: 'Up to 60 seconds per request.' },
    { id: 'long', label: 'Long', wordTimestamps: true, languages: 'multi', note: 'Up to 60 seconds per request.' },
    { id: 'short', label: 'Short', wordTimestamps: true, languages: 'multi', note: 'Up to 60 seconds per request.' }
  ],
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/recognize',
  host(cfg) {
    try {
      return target(cfg).host
    } catch {
      return ''
    }
  },
  async transcribe(req, cfg, fetch) {
    const audio = checkAudio(req.audio)
    const seconds = wavSeconds(audio)
    if (audio.byteLength > GOOGLE_INLINE_BYTES || (seconds !== undefined && seconds > GOOGLE_INLINE_SECONDS)) {
      throw new SttError('Google Speech-to-Text takes at most 60 seconds of audio per request. Use a shorter take or another provider.')
    }
    const t = target(cfg)
    const body = {
      config: {
        autoDecodingConfig: {},
        model: modelId(req.model, 'chirp_3'),
        languageCodes: [googleLanguage(languageCode(req.language))],
        features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true }
      },
      content: base64(audio)
    }
    const answer = await requestJson(fetch, `https://${t.host}${t.path}:recognize`, {
      method: 'POST', headers: { ...auth(cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, { provider: LABEL, signal: req.signal })
    return parseGoogle(answer)
  },
  test(cfg, fetch, signal) {
    return testWith(async () => {
      const t = target(cfg)
      const project = t.path.split('/')[3]
      await requestOk(fetch, `https://${t.host}/v2/projects/${project}/locations/${t.location}`, { method: 'GET', headers: auth(cfg) },
        { provider: LABEL, signal })
    }, 'Connected to Google Cloud Speech-to-Text.')
  }
}
