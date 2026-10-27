import type { SpokenWord, Transcription } from '@shared/speech'
import {
  DICTATION_MAX_BYTES, localModel, prefsFor, sourceParts, spreadWords,
  type DictationConfig, type LocalModelInfo, type LocalModelsState
} from '@shared/dictation'
import { lastWhisperDevice, loadWhisper, loadedWhisper, onWhisperDevice, runWhisper, unloadWhisper, type Device, type WorkerModel } from './whisper'
import { splitAtPauses } from './segments'

// the one place the ui turns audio into words. framework-free, the composer, takes and scripts
// import it. the active source comes from Settings, Dictation: a local model in a worker, or a
// provider through main (keys never reach the page)

export const SAMPLE_RATE = 16_000
// API uploads go as 16-bit WAV, 10 minutes is about 19 MB, under the 25 MB limit
const API_PIECE_SEC = 600

export type { Device }
export { lastWhisperDevice, onWhisperDevice }

function api(): Window['trenddeckDictation'] {
  const bridge = typeof window !== 'undefined' ? window.trenddeckDictation : undefined
  if (!bridge) throw new Error('Dictation is only available in the TrendDeck window.')
  return bridge
}

function abortError(): Error {
  return new DOMException('Transcription cancelled.', 'AbortError')
}

interface ActiveLocal {
  info: LocalModelInfo
  worker: WorkerModel
}

// the active local model as the worker needs it, or why it can't run
function activeLocal(config: DictationConfig, state: LocalModelsState): ActiveLocal | string {
  const parts = sourceParts(config.source)
  const info = parts?.kind === 'local' ? localModel(parts.id, config.customModels) : undefined
  if (!info) return 'Pick a dictation model in Settings, Dictation.'
  const prefs = prefsFor(info, config.localPrefs)
  const status = state.models.find((m) => m.id === info.id)
  if (status?.downloading.some((d) => d.dtype === prefs.dtype)) {
    const d = status.downloading.find((x) => x.dtype === prefs.dtype)!
    return `${info.label} is downloading (${d.total ? Math.floor((d.received / d.total) * 100) : 0}%).`
  }
  if (!status?.installed.includes(prefs.dtype)) return 'Set up dictation in Settings, Dictation.'
  const v = info.variants[prefs.dtype]!
  return {
    info,
    worker: {
      path: `${info.id}/${prefs.dtype}`,
      family: info.family,
      dtype: { encoder_model: v.encoder, decoder_model_merged: v.decoder },
      wordTimes: info.wordTimes,
      englishOnly: info.englishOnly,
      device: prefs.device
    }
  }
}

// 16 kHz mono float samples in, text and word times out. long audio (a 30 minute take) is fine:
// local Whisper runs 30 s windows with overlap, Moonshine and APIs get pieces cut at pauses, and
// the word times stay continuous. onPartial gets the text so far from local models
export async function transcribePcm(
  pcm: Float32Array,
  opts: { signal?: AbortSignal; onPartial?: (text: string) => void } = {}
): Promise<Transcription> {
  const duration = pcm.length / SAMPLE_RATE
  const config = await api().getConfig()
  if (opts.signal?.aborted) throw abortError()
  const parts = sourceParts(config.source)
  if (parts?.kind === 'provider') return transcribeApi(pcm, config, opts.signal)
  if (!pcm.length) return { text: '', words: [], duration: 0, engine: 'local', model: parts?.id ?? '' }
  const local = activeLocal(config, await api().models())
  if (typeof local === 'string') throw new Error(local)
  // the worker takes the samples, the caller keeps its own copy
  const out = await runWhisper(pcm.slice(), {
    model: local.worker, language: local.info.englishOnly ? 'en' : config.language, signal: opts.signal, onPartial: opts.onPartial
  })
  return {
    text: out.text, words: out.words, duration, engine: 'local', model: local.info.id,
    ...(out.approximate ? { wordTimesApproximate: true } : {})
  }
}

async function transcribeApi(pcm: Float32Array, config: DictationConfig, signal?: AbortSignal): Promise<Transcription> {
  const duration = pcm.length / SAMPLE_RATE
  const provider = config.providers.find((p) => `provider:${p.id}` === config.source)
  const bridge = api()
  const cancel = (): void => { void bridge.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const texts: string[] = []
  const words: SpokenWord[] = []
  let approximate = false
  let model = provider?.model ?? ''
  try {
    for (const piece of splitAtPauses(pcm, SAMPLE_RATE, API_PIECE_SEC)) {
      if (signal?.aborted) throw abortError()
      const part = pcm.subarray(piece.start, piece.end)
      const bytes = encodeWav(part)
      if (bytes.byteLength > DICTATION_MAX_BYTES) throw new Error('That recording is too large to upload.')
      const offset = piece.start / SAMPLE_RATE
      let out
      try {
        out = await bridge.transcribe({ bytes, mimeType: 'audio/wav' })
      } catch (err) {
        // a piece of silence has no transcript, the rest still counts
        if (!signal?.aborted && err instanceof Error && /no transcript/i.test(err.message)) continue
        throw err
      }
      model = out.model || model
      texts.push(out.text)
      if (out.words.length) {
        words.push(...out.words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })))
        approximate ||= out.wordTimesApproximate
      } else {
        words.push(...spreadWords(out.text, offset, piece.end / SAMPLE_RATE))
        approximate = true
      }
    }
  } catch (err) {
    if (signal?.aborted) throw abortError()
    throw err instanceof Error ? new Error(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) : err
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
  return {
    text: texts.join(' ').trim(), words, duration, engine: 'api', model,
    ...(approximate ? { wordTimesApproximate: true } : {})
  }
}

// 16-bit PCM WAV, what every transcription API accepts
export function encodeWav(pcm: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const text = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

// any audio or video file the page can fetch (td-media:, blob:) decoded to 16 kHz mono.
// decodeAudioData resamples to the context's rate, the channels are averaged
export async function decodeToPcm(url: string, opts: { signal?: AbortSignal } = {}): Promise<Float32Array> {
  const response = await fetch(url, { signal: opts.signal })
  if (!response.ok) throw new Error(`Could not read the audio (HTTP ${response.status}).`)
  return pcmFromBytes(await response.arrayBuffer())
}

export async function pcmFromBytes(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  let audio: AudioBuffer
  try {
    audio = await ctx.decodeAudioData(bytes)
  } catch {
    throw new Error('That file has no audio this app can read.')
  }
  if (audio.sampleRate === SAMPLE_RATE && audio.numberOfChannels === 1) return audio.getChannelData(0).slice()
  if (audio.sampleRate === SAMPLE_RATE) {
    const out = new Float32Array(audio.length)
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c)
      for (let i = 0; i < out.length; i++) out[i] += data[i] / audio.numberOfChannels
    }
    return out
  }
  // some builds keep the file's own rate, resample with an offline render
  const frames = Math.ceil(audio.duration * SAMPLE_RATE)
  const render = new OfflineAudioContext(1, frames, SAMPLE_RATE)
  const source = render.createBufferSource()
  source.buffer = audio
  source.connect(render.destination)
  source.start()
  return (await render.startRendering()).getChannelData(0).slice()
}

// whether a dictation would work right now, and what to do if not. reason is '' when ready
export async function dictationReady(): Promise<{ ready: boolean; reason: string }> {
  try {
    const config = await api().getConfig()
    const parts = sourceParts(config.source)
    if (parts?.kind === 'provider') {
      const p = config.providers.find((x) => x.id === parts.id)
      if (!p) return { ready: false, reason: 'Pick a dictation source in Settings, Dictation.' }
      return { ready: true, reason: '' }
    }
    const local = activeLocal(config, await api().models())
    return typeof local === 'string' ? { ready: false, reason: local } : { ready: true, reason: '' }
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : 'Dictation settings could not be read.' }
  }
}

// loads the active local model in the background so the first dictation starts fast. never throws
export async function warmUp(): Promise<void> {
  try {
    const config = await api().getConfig()
    const local = activeLocal(config, await api().models())
    if (typeof local !== 'string') await loadWhisper(local.worker)
  } catch {
    // the real dictation reports the problem
  }
}

// ---------- switching, for the composer's mic menu ----------

export interface DictationSourceItem {
  id: string
  label: string
  kind: 'local' | 'local-server' | 'api'
  active: boolean
}

// downloaded local models and configured providers
export async function dictationSources(): Promise<DictationSourceItem[]> {
  const bridge = api()
  const [config, state] = await Promise.all([bridge.getConfig(), bridge.models()])
  const out: DictationSourceItem[] = []
  for (const m of state.models) {
    const info = localModel(m.id, config.customModels)
    if (!info || !m.installed.length) continue
    out.push({ id: `local:${info.id}`, label: info.label, kind: 'local', active: config.source === `local:${info.id}` })
  }
  for (const p of config.providers) {
    out.push({ id: `provider:${p.id}`, label: p.model ? `${p.label}, ${p.model}` : p.label, kind: p.kind, active: config.source === `provider:${p.id}` })
  }
  return out
}

// makes a source active. switching away from a local model frees its memory
export async function useDictationSource(id: string): Promise<void> {
  const config = await api().setSource(id)
  const parts = sourceParts(config.source)
  const info = parts?.kind === 'local' ? localModel(parts.id, config.customModels) : undefined
  const path = info ? `${info.id}/${prefsFor(info, config.localPrefs).dtype}` : ''
  if (loadedWhisper() && loadedWhisper() !== path) await unloadWhisper()
}

// every local model in the catalog, for a quick switcher
export async function localModels(): Promise<{ id: string; label: string; installed: boolean; active: boolean }[]> {
  const bridge = api()
  const [config, state] = await Promise.all([bridge.getConfig(), bridge.models()])
  return state.models.flatMap((m) => {
    const info = localModel(m.id, config.customModels)
    return info ? [{ id: info.id, label: info.label, installed: m.installed.length > 0, active: config.source === `local:${info.id}` }] : []
  })
}

export async function useLocalModel(id: string): Promise<void> {
  await useDictationSource(`local:${id}`)
}

// test runs only (TRENDDECK_TEST_HOOKS=1): lets a driver call the engine from devtools
if (typeof window !== 'undefined' && window.trenddeckDictation?.testHooks) {
  ;(window as unknown as { __tdWhisper: unknown }).__tdWhisper = {
    transcribePcm, decodeToPcm, pcmFromBytes, dictationReady, warmUp, encodeWav, lastWhisperDevice,
    dictationSources, useDictationSource, localModels, useLocalModel
  }
}
