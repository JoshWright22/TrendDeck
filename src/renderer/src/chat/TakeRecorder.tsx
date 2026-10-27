import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment } from '@shared/chat'
import { fromMedia } from './attachments'
import { openSettings } from '../settings-link'
import './take-recorder.css'

export interface TakeRecorderProps {
  brandId: string
  onAttach: (attachments: Attachment[]) => void
  // with a project the take goes into its footage	akes\ folder and shows as a take card in this
  // chat; without one it goes to the media library and gets attached
  projectId?: string | null
  threadId?: string | null
  onSaved?: () => void
  onBusyChange?: (busy: boolean) => void
}

type Phase = 'idle' | 'requesting' | 'recording' | 'stopping' | 'preview' | 'saving'
type Mode = 'mic' | 'camera'
const MAX_BYTES = 250_000_000
const TYPES: Record<Mode, string[]> = {
  mic: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'],
  camera: ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
}

export function TakeRecorder(props: TakeRecorderProps): ReactNode {
  return <Recorder key={props.brandId} {...props} />
}

export default TakeRecorder

function Recorder({ brandId, onAttach, projectId, threadId, onSaved, onBusyChange }: TakeRecorderProps): ReactNode {
  const [mode, setMode] = useState<Mode>('mic')
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const locked = useRef(false)
  const previewUrl = useRef('')
  const savedId = useRef<string | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    onBusyChange?.(phase !== 'idle')
    return () => onBusyChange?.(false)
  }, [phase, onBusyChange])

  const releaseTracks = (): void => {
    stream.current?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    stream.current = null
  }

  const release = (): void => {
    const current = recorder.current
    recorder.current = null
    if (current) {
      current.ondataavailable = null
      current.onstop = null
      current.onerror = null
      current.onstart = null
      if (current.state !== 'inactive') current.stop()
    }
    releaseTracks()
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      release()
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - startedAt.current) / 1000)), 250)
    return () => window.clearInterval(timer)
  }, [phase])

  const discard = (): void => {
    generation.current++
    release()
    locked.current = false
    savedId.current = null
    setBlob(null)
    setPreview('')
    setElapsed(0)
    setError('')
    setPhase('idle')
  }

  const stop = (): void => {
    const current = recorder.current
    if (!current || current.state === 'inactive') return
    setElapsed(Math.floor((performance.now() - startedAt.current) / 1000))
    setPhase('stopping')
    current.stop()
    releaseTracks()
  }

  const start = async (): Promise<void> => {
    if (locked.current) return
    locked.current = true
    const token = ++generation.current
    const valid = (): boolean => mounted.current && generation.current === token
    setError('')
    setPhase('requesting')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Recording is not available on this device.')
      }
      const mimeType = TYPES[mode].find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error('No supported recording format is available.')
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'camera' })
      if (!valid()) {
        acquired.getTracks().forEach((track) => track.stop())
        return
      }
      stream.current = acquired
      const current = new MediaRecorder(acquired, { mimeType })
      recorder.current = current
      const chunks: Blob[] = []
      let size = 0
      const fail = (message: string): void => {
        if (!valid()) return
        discard()
        setError(message)
      }
      current.ondataavailable = (event) => {
        if (!valid() || !event.data.size) return
        size += event.data.size
        if (size > MAX_BYTES) {
          fail('Recording exceeded 250 MB. Please record a shorter take.')
          return
        }
        chunks.push(event.data)
      }
      current.onerror = () => fail('Recording failed. Check your microphone or camera and try again.')
      current.onstart = () => {
        if (!valid()) return
        startedAt.current = performance.now()
        setElapsed(0)
        setPhase('recording')
      }
      current.onstop = () => {
        if (!valid()) return
        setElapsed(Math.floor((performance.now() - startedAt.current) / 1000))
        releaseTracks()
        recorder.current = null
        if (!size) {
          fail('No media was captured. Please try again.')
          return
        }
        const take = new Blob(chunks, { type: current.mimeType || mimeType })
        const url = URL.createObjectURL(take)
        previewUrl.current = url
        setBlob(take)
        setPreview(url)
        setName(`${mode === 'camera' ? 'Camera' : 'Voice'} take ${new Date().toISOString().replace(/[:.]/g, '-')}`)
        setPhase('preview')
      }
      acquired.getTracks().forEach((track) => { track.onended = stop })
      current.start(1000)
    } catch (cause) {
      if (!valid()) return
      release()
      locked.current = false
      setPhase('idle')
      setError(cause instanceof Error ? cause.message : 'Could not access the microphone or camera.')
    }
  }

  const save = async (): Promise<void> => {
    if (!blob || phase !== 'preview' || !name.trim()) return
    const token = ++generation.current
    const valid = (): boolean => mounted.current && generation.current === token
    setPhase('saving')
    setError('')
    try {
      if (projectId) {
        const bytes = await blob.arrayBuffer()
        if (!valid()) return
        await window.trenddeckTakes.saveRecording(brandId, threadId ?? null, projectId, name.trim(), blob.type, bytes)
        if (!valid()) return
        discard()
        onSaved?.()
        return
      }
      if (!savedId.current) {
        const bytes = await blob.arrayBuffer()
        if (!valid()) return
        const result = await window.trenddeck.media.saveRecording(brandId, name.trim(), blob.type, bytes)
        if (!valid()) return
        if (result.added !== 1 || !result.ids[0]) throw new Error('The recording was not saved.')
        savedId.current = result.ids[0]
      }
      const items = await window.trenddeck.media.list(brandId, {})
      if (!valid()) return
      const item = items.find((entry) => entry.id === savedId.current)
      if (!item) throw new Error('Recording saved, but could not be attached. Find it in Media or retry.')
      onAttach([fromMedia(item)])
      discard()
    } catch (cause) {
      if (!valid()) return
      setError(cause instanceof Error ? cause.message : 'Could not save the recording. Please retry.')
      setPhase('preview')
    }
  }

  const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  return (
    <section className='take-recorder' aria-label='Record a take' data-over-craft>
      <strong>Record footage, not a message</strong>
      <p className='take-recorder-hint'>Record, stop, preview, then save. {projectId ? 'Saving adds a take to this project and chat for agent review and cadence feedback; it does not insert it into the edit.' : 'Saving attaches the take to your draft. Send it when you are ready for the agent to review it.'} Use Dictate to speak instructions instead.</p>
      {projectId && <p className='take-recorder-hint'>Transcription uses your Dictation settings. An API source sends audio to that service; a local model stays on this computer. <button type='button' onClick={() => openSettings('Dictation')}>Transcription settings</button></p>}
      <div className='take-recorder-controls'>
        <div className='take-recorder-source' role='group' aria-label='Recording source'>
          <button type='button' aria-pressed={mode === 'mic'} disabled={phase !== 'idle'} onClick={() => setMode('mic')}>Microphone</button>
          <button type='button' aria-pressed={mode === 'camera'} disabled={phase !== 'idle'} onClick={() => setMode('camera')}>Camera and mic</button>
        </div>
        {phase === 'idle' && <button type='button' className='primary' onClick={() => void start()}>Record take</button>}
        {phase === 'requesting' && <><span role='status'>Waiting for the {mode === 'camera' ? 'camera' : 'microphone'}</span><button type='button' onClick={discard}>Cancel</button></>}
        {phase === 'recording' && <><span className='take-recorder-live' role='status'><span className='take-recorder-dot' aria-hidden='true' />Recording <time>{time}</time></span><button type='button' onClick={stop}>Stop</button></>}
        {phase === 'stopping' && <span role='status'>Preparing the preview</span>}
      </div>
      {mode === 'camera' && phase === 'recording' && <video className='take-recorder-video' aria-label='Live camera preview' muted autoPlay playsInline ref={(element) => { if (element) element.srcObject = stream.current }} />}
      {preview && <div className='take-recorder-preview'>
        {mode === 'camera' ? <video className='take-recorder-video' aria-label='Recorded take preview' src={preview} controls playsInline /> : <audio aria-label='Recorded take preview' src={preview} controls />}
        <label>Take name <input value={name} maxLength={200} disabled={phase === 'saving' || savedId.current !== null} onChange={(event) => setName(event.target.value)} /></label>
        <div className='take-recorder-controls'>
          <span>{time}, {blob ? (blob.size / 1_000_000).toFixed(1) : '0'} MB</span>
          <button type='button' disabled={phase === 'saving'} onClick={discard}>Discard</button>
          <button type='button' className='primary' disabled={phase === 'saving' || !name.trim()} onClick={() => void save()}>{phase === 'saving' ? 'Saving' : projectId ? 'Save take' : savedId.current ? 'Retry attach' : 'Save & attach'}</button>
        </div>
      </div>}
      {error && <p className='take-recorder-error' role='alert'>{error}</p>}
    </section>
  )
}
