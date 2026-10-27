/// <reference lib="webworker" />
// local speech models off the page thread: Whisper (and Distil-Whisper) and Moonshine with
// transformers.js and the onnx runtime. WebGPU when asked or on auto when the GPU gives an adapter
// and the session starts, otherwise WebAssembly on the CPU. one model in memory at a time.
// model files only come from td-media://stt/<id>/<dtype>/ (downloaded once by main), the runtime
// from the app's own ort/ folder. nothing here reaches the network.
// protocol, whisper.ts is the only client:
//   in  { type: 'load', id, model, base }                        out { type: 'loaded', id, device }
//   in  { type: 'run', id, model, base, pcm, language, partial } out { type: 'partial', id, text }*,
//                                                                    { type: 'result', id, text, words, approximate, device }
//   in  { type: 'unload', id }                                   out { type: 'unloaded', id }
//   any failure                                                  out { type: 'error', id, message }

import { env, pipeline, WhisperTextStreamer, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import type { SpokenWord } from '@shared/speech'
import { spreadWords } from '@shared/dictation'
import { isSilent, splitAtPauses } from './segments'

export type Device = 'webgpu' | 'wasm'

export interface WorkerModel {
  // <id>/<dtype>, the folder under td-media://stt/
  path: string
  family: 'whisper' | 'moonshine'
  dtype: { encoder_model: string; decoder_model_merged: string }
  wordTimes: 'exact' | 'approximate'
  englishOnly: boolean
  device: 'auto' | Device
}

export interface WorkerBase {
  // td-media://stt/
  models: string
  // file:///.../renderer/ort/ in the built app, http://localhost:5173/ort/ in dev
  ort: string
}

export type WorkerIn =
  | { type: 'load'; id: number; model: WorkerModel; base: WorkerBase }
  | { type: 'run'; id: number; model: WorkerModel; base: WorkerBase; pcm: Float32Array; language: string; partial: boolean }
  | { type: 'unload'; id: number }

export type WorkerOut =
  | { type: 'loaded'; id: number; device: Device }
  | { type: 'partial'; id: number; text: string }
  | { type: 'result'; id: number; text: string; words: SpokenWord[]; approximate: boolean; device: Device }
  | { type: 'unloaded'; id: number }
  | { type: 'error'; id: number; message: string }

const RATE = 16_000
const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: WorkerOut): void => scope.postMessage(msg)

env.allowRemoteModels = false
env.allowLocalModels = true
env.useBrowserCache = false
// no Cache API copies and no blob: urls for the runtime, it loads straight from ort/
env.useWasmCache = false

function configure(base: WorkerBase): void {
  env.localModelPath = base.models
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.wasmPaths = {
      mjs: `${base.ort}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${base.ort}ort-wasm-simd-threaded.asyncify.wasm`
    }
    // no cross-origin isolation in the app window, so no SharedArrayBuffer threads
    wasm.numThreads = 1
  }
}

interface Loaded {
  device: Device
  asr: AutomaticSpeechRecognitionPipeline
}

let current: Promise<Loaded> | null = null
let currentKey = ''
// models whose GPU run failed once stay on the CPU until the worker restarts
const cpuOnly = new Set<string>()

async function create(model: WorkerModel, device: Device): Promise<Loaded> {
  const asr = (await pipeline('automatic-speech-recognition', model.path, {
    device,
    dtype: model.dtype as never,
    // the catalog only lists files without external data
    use_external_data_format: false
  })) as AutomaticSpeechRecognitionPipeline
  return { device, asr }
}

async function gpuAdapter(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function createBest(model: WorkerModel): Promise<Loaded> {
  if (model.device !== 'wasm' && !cpuOnly.has(model.path) && (await gpuAdapter())) {
    try {
      return await create(model, 'webgpu')
    } catch (err) {
      console.warn('[dictation] WebGPU did not start, using the CPU', err)
    }
  }
  return create(model, 'wasm')
}

const keyOf = (model: WorkerModel): string => `${model.path}:${model.device}`

function load(model: WorkerModel, base: WorkerBase): Promise<Loaded> {
  configure(base)
  const key = keyOf(model)
  if (current && currentKey === key) return current
  const previous = current
  currentKey = key
  current = (async () => {
    // switching models frees the old one first
    if (previous) await previous.then((l) => l.asr.dispose()).catch(() => {})
    return createBest(model)
  })()
  current.catch(() => {
    if (currentKey === key) {
      current = null
      currentKey = ''
    }
  })
  return current
}

async function unload(): Promise<void> {
  const previous = current
  current = null
  currentKey = ''
  if (previous) await previous.then((l) => l.asr.dispose()).catch(() => {})
}

// no-speech placeholders: [BLANK_AUDIO], (music), [ Silence ], *coughs*
const TAG = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/
const TAGS = /^(\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*))*\s*$/
const stripTags = (t: string): string => t.replace(/\s*(\[[^\]]*\]|\*[^*]*\*)\s*/g, ' ').replace(/\s+/g, ' ').trim()

interface Chunk { text: string; timestamp: [number | null, number | null] }
interface Out { text: string; words: SpokenWord[]; approximate: boolean }

function streamerFor(l: Loaded, msg: Extract<WorkerIn, { type: 'run' }>, prefix: () => string): WhisperTextStreamer | undefined {
  if (!msg.partial) return undefined
  let partial = ''
  return new WhisperTextStreamer(l.asr.tokenizer as never, {
    skip_prompt: true,
    callback_function: (piece: string) => {
      partial += piece
      const text = `${prefix()} ${stripTags(partial)}`.trim()
      if (text) post({ type: 'partial', id: msg.id, text })
    }
  })
}

async function runWhisper(l: Loaded, msg: Extract<WorkerIn, { type: 'run' }>, duration: number): Promise<Out> {
  const call = async (timestamps: 'word' | true): Promise<{ text: string; chunks?: Chunk[] }> => {
    const streamer = streamerFor(l, msg, () => '')
    const out = await l.asr(msg.pcm, {
      return_timestamps: timestamps,
      // long takes go in 30 s windows with overlap, times stay continuous across them
      ...(duration > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
      // English-only models refuse a language or task
      ...(msg.model.englishOnly ? {} : { task: 'transcribe', ...(msg.language ? { language: msg.language } : {}) }),
      ...(streamer ? { streamer } : {})
    } as never)
    return (Array.isArray(out) ? out[0] : out) as { text: string; chunks?: Chunk[] }
  }
  if (msg.model.wordTimes === 'exact') {
    try {
      const out = await call('word')
      const words: SpokenWord[] = []
      for (const c of out.chunks ?? []) {
        const word = c.text.trim()
        if (!word || TAG.test(word)) continue
        const start = Math.max(0, Number(c.timestamp[0]) || 0)
        const end = c.timestamp[1] == null ? Math.max(start, duration) : Number(c.timestamp[1])
        words.push({ text: word, start, end: Math.max(start, end) })
      }
      return { text: out.text, words, approximate: false }
    } catch (err) {
      if (l.device === 'webgpu') throw err
      // an export without cross attentions can't align words, segment times still work
      console.warn('[dictation] word alignment failed, using segment times', err)
    }
  }
  const out = await call(true)
  const words: SpokenWord[] = []
  for (const c of out.chunks ?? []) {
    const text = stripTags(c.text)
    if (!text) continue
    const start = Math.max(0, Number(c.timestamp[0]) || 0)
    const end = c.timestamp[1] == null ? duration : Math.max(start, Number(c.timestamp[1]))
    words.push(...spreadWords(text, start, end))
  }
  return { text: out.text, words, approximate: true }
}

// Moonshine has no timestamps and no chunking: pieces of up to 20 s cut at pauses, words spread
// over each piece by length
async function runMoonshine(l: Loaded, msg: Extract<WorkerIn, { type: 'run' }>): Promise<Out> {
  const texts: string[] = []
  const words: SpokenWord[] = []
  for (const piece of splitAtPauses(msg.pcm, RATE, 20)) {
    const audio = msg.pcm.subarray(piece.start, piece.end)
    if (isSilent(audio)) continue
    const seconds = audio.length / RATE
    const streamer = streamerFor(l, msg, () => texts.join(' '))
    const out = await l.asr(audio, {
      // the pipeline allows 6 tokens a second, rounded down, which is nothing for short clips
      max_new_tokens: Math.ceil(seconds * 6) + 4,
      ...(streamer ? { streamer } : {})
    } as never)
    const text = stripTags(((Array.isArray(out) ? out[0] : out) as { text: string }).text ?? '')
    if (!text) continue
    texts.push(text)
    words.push(...spreadWords(text, piece.start / RATE, piece.end / RATE))
  }
  return { text: texts.join(' '), words, approximate: true }
}

async function run(msg: Extract<WorkerIn, { type: 'run' }>): Promise<void> {
  const duration = msg.pcm.length / RATE
  let loaded = await load(msg.model, msg.base)
  const go = (l: Loaded): Promise<Out> => (msg.model.family === 'moonshine' ? runMoonshine(l, msg) : runWhisper(l, msg, duration))
  let out: Out
  try {
    out = await go(loaded)
  } catch (err) {
    if (loaded.device !== 'webgpu') throw err
    // some GPUs start a session and then fail on the first run, the CPU always works
    console.warn('[dictation] WebGPU run failed, retrying on the CPU', err)
    cpuOnly.add(msg.model.path)
    currentKey = ''
    loaded = await load(msg.model, msg.base)
    out = await go(loaded)
  }
  let text = out.text.replace(/\s+/g, ' ').trim()
  if (TAGS.test(text)) text = ''
  text = stripTags(text)
  let words = out.words
  let approximate = out.approximate
  // a transcript always comes with words, estimated over the whole clip when nothing better exists
  if (text && !words.length) {
    words = spreadWords(text, 0, duration)
    approximate = true
  }
  if (!text) words = []
  post({ type: 'result', id: msg.id, text, words, approximate, device: loaded.device })
}

scope.addEventListener('message', (event: MessageEvent<WorkerIn>) => {
  const msg = event.data
  const fail = (err: unknown): void => post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  if (msg.type === 'load') {
    load(msg.model, msg.base).then((l) => post({ type: 'loaded', id: msg.id, device: l.device }), fail)
  } else if (msg.type === 'run') {
    run(msg).catch(fail)
  } else if (msg.type === 'unload') {
    unload().then(() => post({ type: 'unloaded', id: msg.id }), fail)
  }
})
