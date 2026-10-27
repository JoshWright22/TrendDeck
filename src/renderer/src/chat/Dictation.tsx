import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_DICTATION_OPTIONS, DICTATION_MAX_BYTES, DICTATION_MAX_RECORDING_MS,
  type DictationApi, type DictationConfig, type DictationOptions
} from '@shared/dictation'
import './dictation.css'

export interface DictationProps {
  api: DictationApi
  onTranscript: (text: string) => void
  disabled?: boolean
}

type Phase = 'idle' | 'requesting' | 'recording' | 'recorded' | 'transcribing' | 'review'

export function Dictation({ api, onTranscript, disabled = false }: DictationProps): ReactNode {
  const [config, setConfig] = useState<DictationConfig | null>(null)
  const [options, setOptions] = useState<DictationOptions>({ ...DEFAULT_DICTATION_OPTIONS })
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [recording, setRecording] = useState<Blob | null>(null)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function releaseMicrophone(): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const current = recorder.current
    recorder.current = null
    if (current && current.state !== 'inactive') current.stop()
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }

  useEffect(() => {
    let mounted = true
    void api.getConfig().then((loaded) => {
      if (mounted) {
        setConfig(loaded)
        setOptions({ mode: loaded.mode, baseUrl: loaded.baseUrl, model: loaded.model })
      }
    }).catch(() => { if (mounted) setError('Could not load dictation settings.') })
    return () => {
      mounted = false
      generation.current++
      releaseMicrophone()
      void api.cancel().catch(() => {})
    }
  }, [api])

  const busy = phase !== 'idle' || saving
  const dirty = !config || options.mode !== config.mode || options.baseUrl !== config.baseUrl || options.model !== config.model

  function cancel(): void {
    generation.current++
    releaseMicrophone()
    setRecording(null)
    setTranscript('')
    setKey('')
    setError('')
    setPhase('idle')
    void api.cancel().catch(() => setError('Could not cancel the server request; it will time out.'))
  }

  async function start(): Promise<void> {
    if (disabled || busy || dirty || !config || (config.mode === 'api' && !config.hasKey)) return
    const currentGeneration = ++generation.current
    setError('')
    setPhase('requesting')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is unavailable.')
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error('No supported audio recording format is available.')
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (generation.current !== currentGeneration) {
        microphone.getTracks().forEach((track) => track.stop())
        return
      }
      stream.current = microphone
      const current = new MediaRecorder(microphone, { mimeType })
      recorder.current = current
      const chunks: Blob[] = []
      let size = 0
      current.ondataavailable = (event) => {
        if (generation.current !== currentGeneration || !event.data.size) return
        size += event.data.size
        if (size > DICTATION_MAX_BYTES) {
          generation.current++
          releaseMicrophone()
          setPhase('idle')
          setError('Recording exceeds 25 MiB. Please record a shorter command.')
          return
        }
        chunks.push(event.data)
      }
      current.onerror = () => {
        if (generation.current !== currentGeneration) return
        generation.current++
        releaseMicrophone()
        setPhase('idle')
        setError('Microphone recording failed. Please try again.')
      }
      current.onstop = () => {
        if (generation.current !== currentGeneration) return
        releaseMicrophone()
        if (!size) {
          setPhase('idle')
          setError('No audio was recorded.')
          return
        }
        setRecording(new Blob(chunks, { type: current.mimeType }))
        setPhase('recorded')
      }
      current.start(1000)
      timer.current = setTimeout(releaseMicrophone, DICTATION_MAX_RECORDING_MS)
      setPhase('recording')
    } catch (failure) {
      if (generation.current !== currentGeneration) return
      releaseMicrophone()
      setPhase('idle')
      setError(failure instanceof Error ? failure.message : 'Microphone permission was denied.')
    }
  }

  async function transcribe(): Promise<void> {
    if (!recording || phase !== 'recorded' || disabled) return
    const currentGeneration = generation.current
    setPhase('transcribing')
    setError('')
    try {
      const bytes = await recording.arrayBuffer()
      if (generation.current !== currentGeneration) return
      const text = await api.transcribe({ bytes, mimeType: recording.type })
      if (generation.current !== currentGeneration) return
      setTranscript(text)
      setRecording(null)
      setPhase('review')
    } catch (failure) {
      if (generation.current !== currentGeneration) return
      setError(failure instanceof Error ? failure.message : 'Transcription failed.')
      setPhase('recorded')
    }
  }

  async function save(): Promise<void> {
    if (busy || disabled) return
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveConfig(options)
      setConfig(saved)
      setOptions({ mode: saved.mode, baseUrl: saved.baseUrl, model: saved.model })
      if (key) setConfig(await api.saveApiKey(key))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save dictation settings.')
    } finally {
      setKey('')
      setSaving(false)
    }
  }

  return (
    <section className="dictation" aria-label="Command dictation">
      <div className="dictation-actions">
        {phase === 'idle' && <button type="button" disabled={disabled || saving || dirty || (config?.mode === 'api' && !config.hasKey)} onClick={() => { void start() }}>Dictate command</button>}
        {phase === 'recording' && <button type="button" onClick={releaseMicrophone}>Stop recording</button>}
        {phase === 'recorded' && <button type="button" disabled={disabled} onClick={() => { void transcribe() }}>{config?.mode === 'api' ? 'Upload and transcribe' : 'Transcribe locally'}</button>}
        {phase !== 'idle' && <button type="button" onClick={cancel}>Cancel dictation</button>}
      </div>
      <p className="dictation-notice" role="status">
        {phase === 'requesting' ? 'Waiting for microphone permission...' : phase === 'recording' ? 'Recording microphone. Stops after two minutes. Nothing is uploaded yet.' : phase === 'transcribing' ? 'Transcribing audio...' : 'Review the transcript before adding it to your draft. Dictation never sends a message.'}
      </p>
      {config?.mode === 'api' && <p className="dictation-notice">API mode: audio will be uploaded to {config.baseUrl} only when you choose Upload and transcribe. The provider may retain audio.</p>}
      {config?.mode === 'local' && <p className="dictation-notice">Local mode sends audio only to your loopback server, with no remote fallback. Your server controls any further processing.</p>}
      {phase === 'review' && <div className="dictation-review">
        <label>Review transcript<textarea rows={3} value={transcript} onChange={(event) => setTranscript(event.target.value)} /></label>
        <button type="button" disabled={disabled || !transcript.trim()} onClick={() => {
          onTranscript(transcript.trim())
          setTranscript('')
          setPhase('idle')
        }}>Append to draft</button>
      </div>}
      <details>
        <summary>Dictation settings</summary>
        <fieldset disabled={disabled || busy}>
          <label>Transcription mode<select value={options.mode} onChange={(event) => {
            setOptions({ ...options, mode: event.target.value as DictationOptions['mode'] })
            setKey('')
          }}><option value="local">Local HTTP server</option><option value="api">Remote API (uploads audio)</option></select></label>
          <label>Base URL (including /v1 if required)<input type="url" value={options.baseUrl} maxLength={2048} onChange={(event) => setOptions({ ...options, baseUrl: event.target.value })} /></label>
          <label>Model<input value={options.model} maxLength={200} onChange={(event) => setOptions({ ...options, model: event.target.value })} /></label>
          <p className="dictation-notice">Uses POST base URL/audio/transcriptions. Run your own Whisper-compatible server for local mode. Changing endpoint or mode clears the saved key.</p>
          {options.mode === 'api' && <>
            <label>API key ({config?.hasKey && !dirty ? 'saved securely' : 'not saved for this endpoint'})<input type="password" value={key} autoComplete="off" spellCheck={false} maxLength={4096} placeholder="Leave blank to keep the saved key" onChange={(event) => setKey(event.target.value)} /></label>
            <p className="dictation-notice">Saved keys are OS-encrypted in the main process and are never returned to this UI. Remote APIs require HTTPS.</p>
          </>}
          <div className="dictation-actions">
            <button type="button" onClick={() => { void save() }}>Save settings</button>
            {config?.hasKey && <button type="button" onClick={() => {
              setSaving(true)
              setKey('')
              setError('')
              void api.saveApiKey('').then(setConfig).catch(() => setError('Could not remove the saved key.')).finally(() => setSaving(false))
            }}>Remove saved key</button>}
          </div>
        </fieldset>
      </details>
      {error && <p className="dictation-error" role="alert">{error}</p>}
    </section>
  )
}

export default Dictation
