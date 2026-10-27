// Azure AI Speech fast transcription.
//   https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create
//   https://learn.microsoft.com/rest/api/speechtotext/transcriptions/transcribe
// POST {endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15, header
// Ocp-Apim-Subscription-Key, multipart: audio + definition (JSON: { locales: ["en-US"] }).
// answer { combinedPhrases: [{ text }], phrases: [{ offsetMilliseconds, durationMilliseconds, text, locale,
// words: [{ text, offsetMilliseconds, durationMilliseconds }] }] }
import {
  SttError, asArray, asRecord, audioMime, checkAudio, field, languageCode, remoteBaseUrl, requestJson, requestOk, secret,
  slug, testWith, joinUrl
} from './http'
import { result, word, type TimedSegment } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'Azure AI Speech'
export const AZURE_API_VERSION = '2025-10-15'

const fields: SttField[] = [
  { key: 'apiKey', label: 'Speech resource key', secret: true, required: true },
  { key: 'region', label: 'Region', secret: false, required: false, placeholder: 'eastus' },
  { key: 'endpoint', label: 'Resource endpoint (instead of region)', secret: false, required: false, kind: 'url', placeholder: 'https://<name>.cognitiveservices.azure.com' }
]

function base(cfg: SttConfig): URL {
  const endpoint = field(cfg, 'endpoint')
  if (endpoint) return remoteBaseUrl(endpoint, 'Azure endpoint')
  const region = field(cfg, 'region')
  if (!region) throw new SttError('Enter the Azure region or resource endpoint.')
  return new URL(`https://${slug(region.toLowerCase(), 'Azure region', /^[a-z0-9]{2,40}$/)}.api.cognitive.microsoft.com`)
}

function auth(cfg: SttConfig): Record<string, string> {
  return { 'Ocp-Apim-Subscription-Key': secret(cfg, 'apiKey') }
}

const LOCALES: Record<string, string> = {
  en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ja: 'ja-JP', ko: 'ko-KR',
  zh: 'zh-CN', hi: 'hi-IN', ru: 'ru-RU', pl: 'pl-PL', tr: 'tr-TR', ar: 'ar-EG', sv: 'sv-SE', uk: 'uk-UA', da: 'da-DK',
  fi: 'fi-FI', nb: 'nb-NO', no: 'nb-NO', cs: 'cs-CZ', el: 'el-GR', he: 'he-IL', id: 'id-ID', th: 'th-TH', vi: 'vi-VN'
}

export function azureLocale(language: string): string | undefined {
  if (!language) return undefined
  return language.includes('-') ? language : LOCALES[language] ?? language
}

export function parseAzure(body: unknown): SttResult {
  const b = asRecord(body)
  const phrases = asArray(b.phrases)
  const combined = asArray(b.combinedPhrases)
  if (!Array.isArray(b.phrases) && !Array.isArray(b.combinedPhrases)) throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  const segments: TimedSegment[] = []
  let exact = true
  for (const p of phrases) {
    const ws = asArray(p.words)
    let got = 0
    for (const w of ws) {
      const off = Number(w.offsetMilliseconds)
      const parsed = word(w.text, off, off + Number(w.durationMilliseconds), 1 / 1000)
      if (parsed) {
        words.push(parsed)
        got++
      }
    }
    if (!got && typeof p.text === 'string') {
      exact = false
      const off = Number(p.offsetMilliseconds)
      segments.push({ text: p.text, start: off / 1000, end: (off + Number(p.durationMilliseconds)) / 1000 })
    }
  }
  const text = combined.map((c) => (typeof c.text === 'string' ? c.text : '')).filter(Boolean).join(' ')
    || phrases.map((p) => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join(' ')
  const language = typeof phrases[0]?.locale === 'string' ? phrases[0].locale : undefined
  return exact ? result(text, words, [], language) : result(text, [], segments, language)
}

export const azure: SttProvider = {
  id: 'azure',
  label: 'Azure AI Speech',
  kind: 'api',
  fields,
  defaultModel: 'fast',
  staticModels: [{ id: 'fast', label: 'Fast transcription', wordTimestamps: true, languages: 'multi' }],
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create',
  host(cfg) {
    try {
      return base(cfg).host
    } catch {
      return ''
    }
  },
  async transcribe(req, cfg, fetch) {
    const audio = checkAudio(req.audio)
    const { mime, extension } = audioMime(req.mimeType)
    const locale = azureLocale(languageCode(req.language))
    const form = new FormData()
    form.append('audio', new Blob([audio], { type: mime }), `audio.${extension}`)
    // no locale: the service identifies the language itself
    form.append('definition', JSON.stringify(locale ? { locales: [locale] } : {}))
    const url = joinUrl(base(cfg), '/speechtotext/transcriptions:transcribe', { 'api-version': AZURE_API_VERSION })
    const body = await requestJson(fetch, url, { method: 'POST', headers: auth(cfg), body: form }, { provider: LABEL, signal: req.signal })
    return parseAzure(body)
  },
  test(cfg, fetch, signal) {
    return testWith(() => requestOk(fetch, joinUrl(base(cfg), '/speechtotext/models/base', { 'api-version': '2024-11-15' }),
      { method: 'GET', headers: auth(cfg) }, { provider: LABEL, signal }), 'Connected to Azure AI Speech.')
  }
}
