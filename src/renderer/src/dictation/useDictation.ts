import { useCallback, useEffect, useRef, useState } from 'react'
import type { DictationConfig, DictationOptions } from '@shared/dictation'
import type { SpokenWord, Transcription } from '@shared/speech'
import { createSegmenter, type Segmenter, type Utterance } from '@shared/vad'
import { cleanError } from '../plain-error'
import { dictationReady, transcribePcm, warmUp } from './engine'
import { openMic, type Mic } from './mic'

// the composer's dictation: the mic, cut into utterances at pauses, each one transcribed while
// you keep talking. finished text goes to onText, the one being transcribed to onPartial (shown
// lighter until it's final). hands-free keeps listening; auto-send fires after a pause

export type DictationState = 'idle' | 'starting' | 'listening' | 'finishing'

export interface DictationHandlers {
  onText: (text: string, t: Transcription) => void
  // '' when nothing is pending
  onPartial: (text: string) => void
  // after a pause with auto-send on and nothing left to transcribe
  onPause?: () => void
}

export interface DictationControl {
  state: DictationState
  // 0 to 1, for the level meter
  level: number
  // seconds since listening started
  elapsed: number
  error: string
  config: DictationConfig | null
  // 'hold' stops when the key goes up
  start: (how?: 'click' | 'hold' | 'hands-free') => void
  stop: () => void
  setOption: (patch: Partial<DictationOptions>) => void
  clearError: () => void
  // shows a problem from elsewhere in the mic controls, e.g. a failed source switch
  showError: (err: unknown, fallback: string) => void
}

// joins everything said since the last send, word times shifted onto one clock
export function joinTranscripts(parts: { t: Transcription; offset: number }[]): Transcription | null {
  if (!parts.length) return null
  const words: SpokenWord[] = []
  for (const p of parts) for (const w of p.t.words) words.push({ text: w.text, start: w.start + p.offset, end: w.end + p.offset })
  const last = parts[parts.length - 1]
  return {
    text: parts.map((p) => p.t.text.trim()).filter(Boolean).join(' '),
    words,
    duration: last.offset + last.t.duration,
    engine: last.t.engine,
    model: last.t.model
  }
}

export function useDictation(h: DictationHandlers): DictationControl {
  const [state, setState] = useState<DictationState>('idle')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<DictationConfig | null>(null)
  const handlers = useRef(h)
  handlers.current = h
  const mic = useRef<Mic | null>(null)
  const seg = useRef<Segmenter | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const startedAt = useRef(0)
  const pauseTimer = useRef<number | null>(null)
  const configRef = useRef<DictationConfig | null>(null)
  configRef.current = config
  const stateRef = useRef<DictationState>('idle')
  stateRef.current = state

  useEffect(() => {
    let alive = true
    const api = window.trenddeckDictation
    void api
      ?.getConfig()
      .then((c) => alive && setConfig(c))
      .catch(() => {})
    // the agent or another view changed it, e.g. dictation_setup picked a model
    const off = api?.onConfigChanged?.((c) => { if (alive) setConfig(c) })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const clearPause = (): void => {
    if (pauseTimer.current !== null) window.clearTimeout(pauseTimer.current)
    pauseTimer.current = null
  }

  const armPause = (): void => {
    clearPause()
    const c = configRef.current
    if (!c?.autoSend) return
    pauseTimer.current = window.setTimeout(() => {
      pauseTimer.current = null
      if (pending.current === 0 && !seg.current?.speaking) handlers.current.onPause?.()
    }, c.autoSendPauseMs)
  }

  const transcribe = (u: Utterance): void => {
    pending.current++
    handlers.current.onPartial('...')
    const controller = abort.current
    queue.current = queue.current.then(async () => {
      try {
        const t = await transcribePcm(u.audio, {
          signal: controller?.signal,
          onPartial: (text) => handlers.current.onPartial(text.trim() || '...')
        })
        if (controller?.signal.aborted) return
        const text = t.text.trim()
        if (text) handlers.current.onText(text, t)
      } catch (err) {
        if (!controller?.signal.aborted) setError(cleanError(err, 'Transcription failed.'))
      } finally {
        pending.current--
        if (pending.current === 0) {
          handlers.current.onPartial('')
          armPause()
        }
      }
    })
  }

  const close = (): void => {
    mic.current?.close()
    mic.current = null
    seg.current = null
    setLevel(0)
  }

  const stop = useCallback((): void => {
    if (stateRef.current !== 'listening' && stateRef.current !== 'starting') return
    seg.current?.flush()
    close()
    setState('finishing')
    void queue.current.then(() => setState((s) => (s === 'finishing' ? 'idle' : s)))
  }, [])

  const start = useCallback((how: 'click' | 'hold' | 'hands-free' = 'click'): void => {
    if (stateRef.current === 'listening' || stateRef.current === 'starting') return
    setError('')
    setState('starting')
    void (async () => {
      const ready = await dictationReady()
      if (!ready.ready) {
        setError(ready.reason)
        setState('idle')
        return
      }
      void warmUp()
      abort.current = new AbortController()
      const segmenter = createSegmenter(transcribe, how === 'hold' ? { pause: 0.8 } : {})
      seg.current = segmenter
      try {
        mic.current = await openMic((frame) => {
          if (seg.current !== segmenter) return
          const wasSpeaking = segmenter.speaking
          segmenter.push(frame)
          if (!wasSpeaking && segmenter.speaking) clearPause()
          // a frame is 128 ms, so the meter redraws about 8 times a second
          setLevel(Math.min(1, segmenter.level * 12))
        })
        if (seg.current !== segmenter) {
          mic.current?.close()
          return
        }
        startedAt.current = performance.now()
        setElapsed(0)
        setState('listening')
      } catch (err) {
        close()
        setState('idle')
        setError(err instanceof DOMException && err.name === 'NotAllowedError' ? 'Microphone access was blocked.' : cleanError(err, "Couldn't open the microphone."))
      }
    })()
  }, [])

  useEffect(() => {
    if (state !== 'listening') return
    const t = window.setInterval(() => setElapsed(Math.floor((performance.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [state])

  // unmounting stops the mic and drops anything still being transcribed
  useEffect(
    () => () => {
      abort.current?.abort()
      clearPause()
      close()
    },
    []
  )

  const setOption = useCallback((patch: Partial<DictationOptions>): void => {
    void window.trenddeckDictation
      ?.saveConfig(patch)
      .then(setConfig)
      .catch((err) => setError(cleanError(err, "Couldn't save that.")))
  }, [])

  return { state, level, elapsed, error, config, start, stop, setOption, clearError: () => setError(''), showError: (err, fallback) => setError(cleanError(err, fallback)) }
}

// "Ctrl+Space" against a key event
export function matchesKey(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase())
  const key = parts[parts.length - 1]
  const want = new Set(parts.slice(0, -1))
  if (want.has('ctrl') !== e.ctrlKey || want.has('alt') !== e.altKey || want.has('shift') !== e.shiftKey || want.has('meta') !== e.metaKey) return false
  const k = e.key === ' ' ? 'space' : e.key.toLowerCase()
  return k === key || e.code.toLowerCase() === key || e.code.toLowerCase() === `key${key}`
}
