// whisper.cpp's own server (examples/server), on this computer.
//   https://github.com/ggml-org/whisper.cpp/tree/master/examples/server  (README + server.cpp)
// POST /inference, multipart: file, temperature, response_format=verbose_json, language, prompt.
// verbose_json is { language: "english", text, segments: [{ text, start, end, words: [{ word, start, end }] }] }
// where "words" are Whisper tokens (" Hel", "lo"), so they are merged back into words here.
// GET /health answers {"status":"ok"} once a model is loaded. the server runs one model, set at start
import {
  SttError, asArray, asRecord, audioMime, checkAudio, field, joinUrl, languageCode, loopbackBaseUrl, requestJson,
  requestOk, testWith
} from './http'
import { result, round, type TimedSegment } from './timing'
import type { SttConfig, SttField, SttProvider, SttResult, SttWord } from './types'

const LABEL = 'whisper.cpp server'

const fields: SttField[] = [
  { key: 'baseUrl', label: 'Server URL', secret: false, required: true, kind: 'url', placeholder: 'http://127.0.0.1:8080', defaultValue: 'http://127.0.0.1:8080' }
]

function base(cfg: SttConfig): URL {
  return loopbackBaseUrl(field(cfg, 'baseUrl', fields))
}

// " [BLANK_AUDIO]", "[_BEG_]", "(music)": markers, not speech
const MARKER = /^[[(].*[\])]$/

export function parseWhisperCpp(body: unknown): SttResult {
  const b = asRecord(body)
  if (typeof b.text !== 'string') throw new SttError(`${LABEL} returned an unreadable response.`)
  const words: SttWord[] = []
  const segments: TimedSegment[] = []
  let timed = true
  for (const seg of asArray(b.segments)) {
    if (typeof seg.text === 'string' && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end))) {
      segments.push({ text: seg.text.replace(/\[[A-Z_]+\]/g, ' '), start: Number(seg.start), end: Number(seg.end) })
    }
    const tokens = asArray(seg.words)
    if (!tokens.length) timed = false
    let current: SttWord | undefined
    const flush = (): void => {
      if (current && current.text.trim() && !MARKER.test(current.text.trim())) words.push({ ...current, text: current.text.trim() })
      current = undefined
    }
    for (const t of tokens) {
      const text = typeof t.word === 'string' ? t.word : ''
      const start = Number(t.start)
      const end = Number(t.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        timed = false
        continue
      }
      if (!text) continue
      // a leading space starts a new word, anything else continues the one before
      if (!current || /^\s/.test(text)) {
        flush()
        current = { text, start: round(start), end: round(Math.max(start, end)) }
      } else {
        current.text += text
        current.end = round(Math.max(current.end, end))
      }
    }
    flush()
  }
  const text = b.text.replace(/\[BLANK_AUDIO\]/g, '').trim()
  return result(text, timed ? words : [], segments, typeof b.language === 'string' ? b.language : undefined)
}

export const whisperCpp: SttProvider = {
  id: 'whisper-cpp',
  label: LABEL,
  kind: 'local-server',
  fields,
  defaultModel: 'loaded',
  staticModels: [{ id: 'loaded', label: 'The model the server was started with', wordTimestamps: true, languages: 'multi' }],
  supportsWordTimestamps: true,
  supportsStreaming: false,
  docsUrl: 'https://github.com/ggml-org/whisper.cpp/tree/master/examples/server',
  host(cfg) {
    try {
      return base(cfg).host
    } catch {
      return ''
    }
  },
  async transcribe(req, cfg, fetch) {
    const url = joinUrl(base(cfg), '/inference')
    const audio = checkAudio(req.audio)
    const { mime, extension } = audioMime(req.mimeType)
    const language = languageCode(req.language)
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `audio.${extension}`)
    form.append('temperature', '0.0')
    form.append('response_format', 'verbose_json')
    // token times come with verbose_json by default; asked for explicitly for older builds
    form.append('token_timestamps', 'true')
    form.append('language', language || 'auto')
    if (req.prompt?.trim()) form.append('prompt', req.prompt.trim().slice(0, 2000))
    const body = await requestJson(fetch, url, { method: 'POST', body: form }, { provider: LABEL, signal: req.signal })
    return parseWhisperCpp(body)
  },
  test(cfg, fetch, signal) {
    return testWith(() => requestOk(fetch, joinUrl(base(cfg), '/health'), { method: 'GET' }, { provider: LABEL, signal }), `${LABEL} is answering.`)
  }
}
