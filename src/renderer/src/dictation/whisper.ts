import type { SpokenWord } from '@shared/speech'
import type { Device, WorkerBase, WorkerIn, WorkerModel, WorkerOut } from './whisper.worker'

// the page side of the local speech worker: starts it on first use, keeps one model loaded, runs
// one job at a time, and drops the worker (and the model's memory) after five idle minutes

export type { Device, WorkerModel }

export interface WhisperResult {
  text: string
  words: SpokenWord[]
  approximate: boolean
  device: Device
}

const IDLE_MS = 5 * 60_000
const DEVICE_KEY = 'trenddeck.dictation.device'

interface Job {
  id: number
  msg: WorkerIn
  resolve: (out: WorkerOut) => void
  reject: (err: Error) => void
  onPartial?: (text: string) => void
  cleanup: () => void
}

let worker: Worker | null = null
let running: Job | null = null
const queue: Job[] = []
let nextId = 1
let idleTimer: ReturnType<typeof setTimeout> | null = null
let loadedPath = ''
const listeners = new Set<(device: Device) => void>()

function base(): WorkerBase {
  return { models: 'td-media://stt/', ort: new URL('ort/', document.baseURI).href }
}

function abortError(): Error {
  return new DOMException('Transcription cancelled.', 'AbortError')
}

function stop(reason: Error): void {
  const w = worker
  worker = null
  loadedPath = ''
  w?.terminate()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const job = running
  running = null
  if (job) {
    job.cleanup()
    job.reject(reason)
  }
}

function spawn(): Worker {
  const w = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module', name: 'dictation' })
  w.addEventListener('message', (event: MessageEvent<WorkerOut>) => {
    const out = event.data
    const job = running
    if (!job || out.id !== job.id) return
    if (out.type === 'partial') {
      job.onPartial?.(out.text)
      return
    }
    running = null
    job.cleanup()
    if (out.type === 'error') job.reject(new Error(out.message))
    else {
      if (out.type === 'loaded' || out.type === 'result') noteDevice(out.device)
      job.resolve(out)
    }
    pump()
  })
  // a crash (out of memory, a broken GPU driver) fails the job, the next one starts a new worker
  w.addEventListener('error', (event) => {
    event.preventDefault()
    stop(new Error('Local dictation stopped unexpectedly. Try again, or pick a smaller model in Settings, Dictation.'))
    pump()
  })
  w.addEventListener('messageerror', () => {
    stop(new Error('Local dictation could not read the audio.'))
    pump()
  })
  return w
}

function pump(): void {
  if (running) return
  const job = queue.shift()
  if (!job) {
    if (idleTimer) clearTimeout(idleTimer)
    if (worker) idleTimer = setTimeout(() => stop(new Error('unloaded')), IDLE_MS)
    return
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  worker ??= spawn()
  running = job
  if (job.msg.type === 'run' || job.msg.type === 'load') loadedPath = job.msg.model.path
  if (job.msg.type === 'unload') loadedPath = ''
  if (job.msg.type === 'run') worker.postMessage(job.msg, [job.msg.pcm.buffer])
  else worker.postMessage(job.msg)
}

function submit(msg: WorkerIn, opts: { signal?: AbortSignal; onPartial?: (text: string) => void } = {}): Promise<WorkerOut> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError())
    const job: Job = { id: msg.id, msg, resolve, reject, onPartial: opts.onPartial, cleanup: () => {} }
    const onAbort = (): void => {
      const i = queue.indexOf(job)
      if (i >= 0) {
        queue.splice(i, 1)
        job.cleanup()
        reject(abortError())
      } else if (running === job) {
        // inference can't be interrupted inside the worker, so the worker goes. the model reloads next time
        stop(abortError())
        pump()
      }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    job.cleanup = () => opts.signal?.removeEventListener('abort', onAbort)
    queue.push(job)
    pump()
  })
}

// loads a model so the first dictation doesn't wait for it
export async function loadWhisper(model: WorkerModel): Promise<Device> {
  const out = await submit({ type: 'load', id: nextId++, model, base: base() })
  if (out.type !== 'loaded') throw new Error('Local dictation did not load.')
  return out.device
}

// 16 kHz mono samples. the array is handed to the worker, pass a copy if you still need it
export async function runWhisper(
  pcm: Float32Array,
  opts: { model: WorkerModel; language: string; signal?: AbortSignal; onPartial?: (text: string) => void }
): Promise<WhisperResult> {
  const out = await submit(
    { type: 'run', id: nextId++, model: opts.model, base: base(), pcm, language: opts.language, partial: !!opts.onPartial },
    { signal: opts.signal, onPartial: opts.onPartial }
  )
  if (out.type !== 'result') throw new Error('Local dictation returned nothing.')
  return { text: out.text, words: out.words, approximate: out.approximate, device: out.device }
}

// frees the loaded model's memory, e.g. after switching or deleting. queued work still runs first
export async function unloadWhisper(): Promise<void> {
  if (!worker && !queue.length && !running) return
  if (!running && !queue.length) {
    stop(new Error('unloaded'))
    return
  }
  await submit({ type: 'unload', id: nextId++ }).catch(() => {})
}

// the <id>/<dtype> the worker has (or is about to have) in memory, '' when none
export function loadedWhisper(): string {
  return loadedPath
}

function noteDevice(device: Device): void {
  try {
    localStorage.setItem(DEVICE_KEY, device)
  } catch {
    // storage full or off, the label just stays empty
  }
  for (const fn of listeners) fn(device)
}

// where a local model ran last: WebGPU or the CPU. null before the first use
export function lastWhisperDevice(): Device | null {
  try {
    const v = localStorage.getItem(DEVICE_KEY)
    return v === 'webgpu' || v === 'wasm' ? v : null
  } catch {
    return null
  }
}

export function onWhisperDevice(fn: (device: Device) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
