import { describe, expect, it, vi } from 'vitest'
import { createAssemblyAi } from './assemblyai'
import { aws } from './aws'
import { AZURE_API_VERSION, azure } from './azure'
import { deepgram } from './deepgram'
import { elevenlabs } from './elevenlabs'
import { createGladia } from './gladia'
import { google } from './google'
import { SttError, type PollDeps } from './http'
import { STT_PROVIDERS } from './index'
import { mistral } from './mistral'
import { fireworks, groq, localai, openai, openaiCompatible, speaches } from './openai-compatible'
import { createRevAi } from './revai'
import { createSpeechmatics } from './speechmatics'
import type { Fetch, SttRequest } from './types'
import { whisperCpp } from './whispercpp'

// adapters are checked against the request and answer shapes in each provider's API reference.
// keys here are empty: the adapters pass '' through and the fake server never checks it

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Route = [RegExp, (call: Call) => Response]

function fakeFetch(routes: Route[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body
    }
    calls.push(call)
    expect(init?.redirect).toBe('error')
    const route = routes.find(([re]) => re.test(call.url))
    if (!route) return new Response('not found', { status: 404 })
    return route[1](call)
  }) as unknown as Fetch
  return { fetch, calls }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const audio = (): ArrayBuffer => new Uint8Array([1, 2, 3, 4]).buffer
const req = (over: Partial<SttRequest> = {}): SttRequest => ({ audio: audio(), mimeType: 'audio/wav', model: '', ...over })
const instant: PollDeps = { sleep: async () => {}, now: () => 0 }
const form = (call: Call): FormData => call.body as FormData

describe('provider registry', () => {
  it('has unique ids, a docs link and a default model for every usable adapter', () => {
    const ids = STT_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of STT_PROVIDERS) {
      expect(p.docsUrl).toMatch(/^https:\/\//)
      if (p.unavailable) continue
      expect(p.defaultModel).toBeTruthy()
      for (const f of p.fields) if (f.secret) expect(f.key).toMatch(/key|token/i)
    }
    expect(STT_PROVIDERS.filter((p) => p.kind === 'local-server').map((p) => p.id))
      .toEqual(['whisper-cpp', 'speaches', 'localai', 'local-openai-compatible'])
  })

  it('marks AWS Transcribe as coming later', async () => {
    expect(aws.unavailable).toMatch(/later/)
    await expect(aws.transcribe(req(), {}, vi.fn())).rejects.toThrow(SttError)
  })
})

describe('OpenAI-style adapters', () => {
  it('OpenAI asks whisper-1 for verbose_json word times with a bearer key', async () => {
    const { fetch, calls } = fakeFetch([[/audio\/transcriptions$/, () => json({
      text: 'Hello there.', language: 'english', words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'there.', start: 0.4, end: 0.9 }]
    })]])
    const out = await openai.transcribe(req({ model: 'whisper-1', language: 'en' }), { apiKey: '' }, fetch)
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer ' })
    expect(form(calls[0]).get('response_format')).toBe('verbose_json')
    expect(form(calls[0]).getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
    expect(form(calls[0]).get('language')).toBe('en')
    expect(out).toEqual({ text: 'Hello there.', words: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'there.', start: 0.4, end: 0.9 }], language: 'en', wordTimesApproximate: false })
  })

  it('gpt-4o-transcribe gets plain json and comes back without word times', async () => {
    const { fetch, calls } = fakeFetch([[/audio\/transcriptions$/, () => json({ text: 'Hi.' })]])
    const out = await openai.transcribe(req({ model: 'gpt-4o-transcribe' }), { apiKey: '' }, fetch)
    expect(form(calls[0]).get('response_format')).toBe('json')
    expect(form(calls[0]).has('timestamp_granularities[]')).toBe(false)
    expect(out).toMatchObject({ text: 'Hi.', words: [], wordTimesApproximate: true })
  })

  it('a generic endpoint retries once with plain json after a 400', async () => {
    let n = 0
    const { fetch, calls } = fakeFetch([[/audio\/transcriptions$/, () => (n++ ? json({ text: 'ok' }) : json({ error: 'no' }, 400))]])
    await openaiCompatible.transcribe(req({ model: 'm' }), { baseUrl: 'https://gw.example/openai/v1' }, fetch)
    expect(calls.map((c) => form(c).get('response_format'))).toEqual(['verbose_json', 'json'])
    expect(calls[0].url).toBe('https://gw.example/openai/v1/audio/transcriptions')
    // no key typed: no header
    expect(calls[0].headers).toEqual({})
  })

  it('refuses http for hosted endpoints and remote hosts for local servers', async () => {
    const { fetch } = fakeFetch([])
    await expect(openaiCompatible.transcribe(req(), { baseUrl: 'http://gw.example/v1' }, fetch)).rejects.toThrow('HTTPS')
    await expect(speaches.transcribe(req(), { baseUrl: 'http://10.0.0.2:8000/v1' }, fetch)).rejects.toThrow('this computer')
    await expect(openaiCompatible.transcribe(req(), { baseUrl: 'https://user:pw@gw.example/v1' }, fetch)).rejects.toThrow('credentials')
    expect(speaches.host({ baseUrl: 'http://localhost:8000/v1' })).toBe('127.0.0.1:8000')
  })

  it('Groq filters its model list to active Whisper models', async () => {
    const { fetch } = fakeFetch([[/\/models$/, () => json({ data: [
      { id: 'whisper-large-v3', active: true }, { id: 'llama-3.3-70b', active: true }, { id: 'whisper-old', active: false }
    ] })]])
    expect((await groq.listModels!({ apiKey: '' }, fetch)).map((m) => m.id)).toEqual(['whisper-large-v3'])
  })

  it('Fireworks sends turbo to its own host', async () => {
    const { fetch, calls } = fakeFetch([[/fireworks/, () => json({ text: 'x' })]])
    await fireworks.transcribe(req({ model: 'whisper-v3-turbo' }), { apiKey: '' }, fetch)
    await fireworks.transcribe(req({ model: 'whisper-v3' }), { apiKey: '' }, fetch)
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      'audio-turbo.us-virginia-1.direct.fireworks.ai', 'audio-prod.us-virginia-1.direct.fireworks.ai'
    ])
  })

  it('LocalAI nanosecond times are scaled to seconds, segments spread when there are no words', async () => {
    const { fetch } = fakeFetch([[/audio\/transcriptions$/, () => json({
      text: 'one two', segments: [{ text: 'one two', start: 0, end: 2_000_000_000 }]
    })]])
    const out = await localai.transcribe(req(), { baseUrl: 'http://127.0.0.1:8080/v1' }, fetch)
    expect(out.wordTimesApproximate).toBe(true)
    expect(out.words.map((w) => w.text)).toEqual(['one', 'two'])
    expect(out.words.at(-1)!.end).toBe(2)
  })
})

describe('whisper.cpp server', () => {
  it('merges Whisper tokens into words and drops markers', async () => {
    const { fetch, calls } = fakeFetch([[/\/inference$/, () => json({
      language: 'english', text: ' Hello world [BLANK_AUDIO]',
      segments: [{ text: ' Hello world', start: 0, end: 1.2, words: [
        { word: ' Hel', start: 0, end: 0.2 }, { word: 'lo', start: 0.2, end: 0.4 }, { word: ' world', start: 0.5, end: 1.1 },
        { word: ' [BLANK_AUDIO]', start: 1.1, end: 1.2 }
      ] }]
    })]])
    const out = await whisperCpp.transcribe(req(), { baseUrl: 'http://127.0.0.1:8080' }, fetch)
    expect(calls[0].url).toBe('http://127.0.0.1:8080/inference')
    expect(form(calls[0]).get('language')).toBe('auto')
    expect(out).toEqual({ text: 'Hello world', words: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world', start: 0.5, end: 1.1 }], language: 'en', wordTimesApproximate: false })
  })
})

describe('Deepgram', () => {
  it('posts raw audio with a Token header and reads punctuated words', async () => {
    const { fetch, calls } = fakeFetch([[/\/v1\/listen/, () => json({ results: { channels: [{ detected_language: 'en', alternatives: [{
      transcript: 'hello there', words: [
        { word: 'hello', punctuated_word: 'Hello', start: 0.1, end: 0.5 }, { word: 'there', punctuated_word: 'there.', start: 0.5, end: 0.9 }
      ]
    }] }] } })]])
    const out = await deepgram.transcribe(req({ model: 'nova-3' }), { apiKey: '', region: 'eu' }, fetch)
    const url = new URL(calls[0].url)
    expect(url.host).toBe('api.eu.deepgram.com')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('detect_language')).toBe('true')
    expect(calls[0].headers).toEqual({ Authorization: 'Token ', 'Content-Type': 'audio/wav' })
    expect(calls[0].body).toBeInstanceOf(ArrayBuffer)
    expect(out.words).toEqual([{ text: 'Hello', start: 0.1, end: 0.5 }, { text: 'there.', start: 0.5, end: 0.9 }])
  })
})

describe('AssemblyAI', () => {
  it('uploads, creates the job with the model, polls and reads millisecond words', async () => {
    let polls = 0
    const { fetch, calls } = fakeFetch([
      [/\/v2\/upload$/, () => json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' })],
      [/\/v2\/transcript$/, () => json({ id: 'job-1', status: 'queued' })],
      [/\/v2\/transcript\/job-1$/, () => json(polls++ ? {
        status: 'completed', text: 'Hi there.', language_code: 'en', words: [{ text: 'Hi', start: 100, end: 300 }, { text: 'there.', start: 300, end: 700 }]
      } : { status: 'processing' })]
    ])
    const out = await createAssemblyAi(instant).transcribe(req({ model: 'universal-2' }), { apiKey: '' }, fetch)
    expect(calls[0].headers).toMatchObject({ authorization: '' })
    expect(JSON.parse(calls[1].body as string)).toMatchObject({ audio_url: 'https://cdn.assemblyai.com/upload/abc', speech_models: ['universal-2'], language_detection: true })
    expect(calls.filter((c) => c.url.endsWith('job-1'))).toHaveLength(2)
    expect(out.words).toEqual([{ text: 'Hi', start: 0.1, end: 0.3 }, { text: 'there.', start: 0.3, end: 0.7 }])
  })

  it('reports a failed job without the provider text', async () => {
    const { fetch } = fakeFetch([
      [/\/v2\/upload$/, () => json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' })],
      [/\/v2\/transcript$/, () => json({ id: 'job-1' })],
      [/job-1$/, () => json({ status: 'error', error: 'internal detail' })]
    ])
    const error = await createAssemblyAi(instant).transcribe(req(), { apiKey: '' }, fetch).catch((e: Error) => e)
    expect((error as Error).message).toBe('AssemblyAI could not transcribe the audio.')
  })
})

describe('ElevenLabs Scribe', () => {
  it('asks for word timestamps and skips spacing tokens', async () => {
    const { fetch, calls } = fakeFetch([[/speech-to-text$/, () => json({
      text: 'Hi you', language_code: 'eng', words: [
        { text: 'Hi', start: 0, end: 0.3, type: 'word' }, { text: ' ', start: 0.3, end: 0.35, type: 'spacing' }, { text: 'you', start: 0.35, end: 0.6, type: 'word' }
      ]
    })]])
    const out = await elevenlabs.transcribe(req(), { apiKey: '' }, fetch)
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(calls[0].headers).toEqual({ 'xi-api-key': '' })
    expect(form(calls[0]).get('model_id')).toBe('scribe_v2')
    expect(form(calls[0]).get('timestamps_granularity')).toBe('word')
    expect(out.words.map((w) => w.text)).toEqual(['Hi', 'you'])
  })
})

describe('Google Cloud Speech-to-Text v2', () => {
  it('sends base64 audio to the regional recognizer with the key in a header, never the url', async () => {
    const { fetch, calls } = fakeFetch([[/:recognize$/, () => json({ results: [{ alternatives: [{
      transcript: 'hello world', words: [{ word: 'hello', startOffset: '0s', endOffset: '0.500s' }, { word: 'world', startOffset: '0.500s', endOffset: '1.100s' }]
    }], languageCode: 'en-us' }] })]])
    const out = await google.transcribe(req({ language: 'en' }), { apiKey: '', project: 'my-proj', location: 'us-central1' }, fetch)
    expect(calls[0].url).toBe('https://us-central1-speech.googleapis.com/v2/projects/my-proj/locations/us-central1/recognizers/_:recognize')
    expect(calls[0].headers).toMatchObject({ 'x-goog-api-key': '' })
    const body = JSON.parse(calls[0].body as string)
    expect(body.config).toMatchObject({ model: 'chirp_3', languageCodes: ['en-US'], features: { enableWordTimeOffsets: true } })
    expect(body.content).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'))
    expect(out.words).toEqual([{ text: 'hello', start: 0, end: 0.5 }, { text: 'world', start: 0.5, end: 1.1 }])
  })

  it('refuses project ids that would change the path', async () => {
    await expect(google.transcribe(req(), { apiKey: '', project: '../x' }, vi.fn())).rejects.toThrow('project ID')
  })
})

describe('Azure AI Speech', () => {
  it('posts audio and definition to fast transcription and reads millisecond word offsets', async () => {
    const { fetch, calls } = fakeFetch([[/transcriptions:transcribe/, () => json({
      combinedPhrases: [{ text: 'Hello world.' }],
      phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 1000, text: 'Hello world.', locale: 'en-US', words: [
        { text: 'Hello', offsetMilliseconds: 0, durationMilliseconds: 400 }, { text: 'world.', offsetMilliseconds: 500, durationMilliseconds: 500 }
      ] }]
    })]])
    const out = await azure.transcribe(req({ language: 'de' }), { apiKey: '', region: 'westeurope' }, fetch)
    expect(calls[0].url).toBe(`https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`)
    expect(calls[0].headers).toEqual({ 'Ocp-Apim-Subscription-Key': '' })
    expect(JSON.parse(form(calls[0]).get('definition') as string)).toEqual({ locales: ['de-DE'] })
    expect(out.words).toEqual([{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world.', start: 0.5, end: 1 }])
  })
})

describe('Speechmatics', () => {
  it('creates a job with the operating point, polls and glues punctuation onto words', async () => {
    let polls = 0
    const { fetch, calls } = fakeFetch([
      [/\/v2\/jobs$/, () => json({ id: 'abc123' })],
      [/\/v2\/jobs\/abc123$/, () => json({ job: { status: polls++ ? 'done' : 'running' } })],
      [/\/v2\/jobs\/abc123\/transcript/, () => json({ results: [
        { type: 'word', start_time: 0.1, end_time: 0.4, alternatives: [{ content: 'Hello', language: 'en' }] },
        { type: 'punctuation', start_time: 0.4, end_time: 0.4, alternatives: [{ content: ',' }] },
        { type: 'word', start_time: 0.5, end_time: 0.9, alternatives: [{ content: 'you' }] }
      ] })]
    ])
    const out = await createSpeechmatics(instant).transcribe(req({ model: 'standard' }), { apiKey: '', region: 'us' }, fetch)
    expect(calls[0].url).toBe('https://us1.asr.api.speechmatics.com/v2/jobs')
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer ' })
    expect(JSON.parse(form(calls[0]).get('config') as string)).toEqual({ type: 'transcription', transcription_config: { language: 'auto', operating_point: 'standard' } })
    expect(calls.at(-1)!.url).toBe('https://us1.asr.api.speechmatics.com/v2/jobs/abc123/transcript?format=json-v2')
    expect(out).toEqual({ text: 'Hello, you', words: [{ text: 'Hello,', start: 0.1, end: 0.4 }, { text: 'you', start: 0.5, end: 0.9 }], language: 'en', wordTimesApproximate: false })
  })

  it('stops on a rejected job', async () => {
    const { fetch } = fakeFetch([[/\/v2\/jobs$/, () => json({ id: 'abc123' })], [/abc123$/, () => json({ job: { status: 'rejected' } })]])
    await expect(createSpeechmatics(instant).transcribe(req(), { apiKey: '' }, fetch)).rejects.toThrow('could not transcribe')
  })
})

describe('Rev.ai', () => {
  it('submits media with options, polls and reads text and punct elements', async () => {
    let polls = 0
    const { fetch, calls } = fakeFetch([
      [/\/jobs$/, () => json({ id: 'Umx5c6F7pH7r', status: 'in_progress' })],
      [/\/jobs\/Umx5c6F7pH7r$/, () => json({ status: polls++ ? 'transcribed' : 'in_progress' })],
      [/\/transcript$/, () => json({ monologues: [{ elements: [
        { type: 'text', value: 'Hi', ts: 0.2, end_ts: 0.5 }, { type: 'punct', value: ' ' }, { type: 'text', value: 'there', ts: 0.6, end_ts: 0.9 },
        { type: 'punct', value: '.' }
      ] }] })]
    ])
    const out = await createRevAi(instant).transcribe(req({ language: 'en' }), { apiKey: '' }, fetch)
    expect(calls[0].url).toBe('https://api.rev.ai/speechtotext/v1/jobs')
    expect(JSON.parse(form(calls[0]).get('options') as string)).toEqual({ transcriber: 'machine', language: 'en' })
    expect(calls.at(-1)!.headers).toMatchObject({ Accept: 'application/vnd.rev.transcript.v1.0+json' })
    expect(out).toMatchObject({ text: 'Hi there.', words: [{ text: 'Hi', start: 0.2, end: 0.5 }, { text: 'there.', start: 0.6, end: 0.9 }] })
  })
})

describe('Gladia', () => {
  it('uploads, starts a pre-recorded job and reads utterance words', async () => {
    let polls = 0
    const { fetch, calls } = fakeFetch([
      [/\/v2\/upload$/, () => json({ audio_url: 'https://api.gladia.io/file/1' })],
      [/\/v2\/pre-recorded$/, () => json({ id: 'f2b9c6d4-1', result_url: 'x' })],
      [/\/v2\/pre-recorded\/f2b9c6d4-1$/, () => json(polls++ ? { status: 'done', result: { transcription: {
        full_transcript: 'Hello there', languages: ['en'], utterances: [{ words: [{ word: ' Hello', start: 0, end: 0.4 }, { word: ' there', start: 0.4, end: 0.8 }] }]
      } } } : { status: 'processing' })]
    ])
    const out = await createGladia(instant).transcribe(req({ language: 'fr' }), { apiKey: '' }, fetch)
    expect(calls[0].headers).toEqual({ 'x-gladia-key': '' })
    expect(JSON.parse(calls[1].body as string)).toEqual({ audio_url: 'https://api.gladia.io/file/1', language_config: { languages: ['fr'], code_switching: false } })
    expect(out).toEqual({ text: 'Hello there', words: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'there', start: 0.4, end: 0.8 }], language: 'en', wordTimesApproximate: false })
  })
})

describe('Mistral', () => {
  it('asks for word times only without a set language', async () => {
    const { fetch, calls } = fakeFetch([[/audio\/transcriptions$/, () => json({
      text: 'Hi you', language: 'en', segments: [{ text: 'Hi', start: 0, end: 0.3 }, { text: 'you', start: 0.4, end: 0.6 }]
    })]])
    const out = await mistral.transcribe(req(), { apiKey: '' }, fetch)
    expect(form(calls[0]).get('timestamp_granularities')).toBe('word')
    expect(calls[0].headers).toEqual({ 'x-api-key': '' })
    expect(out.words).toEqual([{ text: 'Hi', start: 0, end: 0.3 }, { text: 'you', start: 0.4, end: 0.6 }])
    await mistral.transcribe(req({ language: 'en' }), { apiKey: '' }, fetch)
    expect(form(calls[1]).has('timestamp_granularities')).toBe(false)
  })
})

describe('shared request rules', () => {
  it('turns HTTP errors into plain messages without the body', async () => {
    const { fetch } = fakeFetch([[/listen/, () => new Response('{"err":"secret detail"}', { status: 401 })]])
    const error = (await deepgram.transcribe(req(), { apiKey: '' }, fetch).catch((e: Error) => e)) as SttError
    expect(error).toBeInstanceOf(SttError)
    expect(error.status).toBe(401)
    expect(error.message).not.toContain('secret detail')
  })

  it('caps response size', async () => {
    const { fetch } = fakeFetch([[/listen/, () => new Response('x'.repeat(1024 * 1024 + 10))]])
    await expect(deepgram.transcribe(req(), { apiKey: '' }, fetch)).rejects.toThrow('larger than')
  })

  it('test() never uploads audio', async () => {
    const { fetch, calls } = fakeFetch([[/./, () => json({})]])
    for (const p of STT_PROVIDERS) {
      if (!p.test) continue
      const cfg: Record<string, string> = { apiKey: '', project: 'p', region: p.id === 'azure' ? 'eastus' : '', baseUrl: p.kind === 'local-server' ? 'http://127.0.0.1:8080/v1' : 'https://gw.example/v1' }
      if (p.id !== 'azure') delete cfg.region
      const r = await p.test(cfg, fetch)
      expect(r.ok, `${p.id}: ${r.message}`).toBe(true)
    }
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
})
