import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import {
  clampReviewTime, formatVideoReviewFeedback, formatReviewTime, reviewLoopTarget,
  reviewRegionFromDrag, updateReviewRange,
  type VideoReviewFrame, type VideoReviewRange, type VideoReviewRegion
} from './VideoReview.helpers'
import './VideoReview.css'

export type { VideoReviewFrame, VideoReviewRange, VideoReviewRegion } from './VideoReview.helpers'

export interface VideoReviewProps {
  src: string
  name: string
  clipId: string
  revision?: string
  onFeedback: (text: string) => void | Promise<void>
  onFrame?: (frame: VideoReviewFrame) => void | Promise<void>
}

interface CapturedFrame {
  canvas: HTMLCanvasElement
  dataUrl: string
  timeSeconds: number
}

export function VideoReview(props: VideoReviewProps): ReactNode {
  return <VideoReviewSession key={JSON.stringify([props.src, props.clipId, props.revision])} {...props} />
}

function VideoReviewSession({ src, name, clipId, revision, onFeedback, onFrame }: VideoReviewProps): ReactNode {
  const id = useId()
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragRef = useRef<{ pointerId: number; start: { x: number; y: number }; previous: VideoReviewRegion | null } | null>(null)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [range, setRange] = useState<VideoReviewRange>({ startSeconds: 0, endSeconds: 0 })
  const [loop, setLoop] = useState(false)
  const [text, setText] = useState('')
  const [frame, setFrame] = useState<CapturedFrame | null>(null)
  const [region, setRegion] = useState<VideoReviewRegion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [status, setStatus] = useState('')
  const ready = duration > 0 && !mediaError
  const canLoop = range.endSeconds > range.startSeconds

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!loop || !playing || !canLoop) return
    let request = 0
    const tick = (): void => {
      const video = videoRef.current
      if (video && !video.paused && !video.seeking) {
        const target = reviewLoopTarget(video.currentTime, range)
        if (target !== null) video.currentTime = target
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [loop, playing, canLoop, range])

  async function play(): Promise<void> {
    const video = videoRef.current
    if (!video) return
    try {
      if (loop && canLoop) {
        const target = reviewLoopTarget(video.currentTime, range)
        if (target !== null) video.currentTime = target
      }
      await video.play()
    } catch {
      if (mountedRef.current) setError('Playback could not start. Try the native video controls.')
    }
  }

  function seek(value: number): void {
    const video = videoRef.current
    if (!video || !ready) return
    video.currentTime = clampReviewTime(value, duration)
    setTime(video.currentTime)
  }

  function captureFrame(): void {
    const video = videoRef.current
    if (!video || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) {
      setError('Wait for the current frame to finish loading before capturing.')
      return
    }
    video.pause()
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.drawImage(video, 0, 0)
      setFrame({ canvas, dataUrl: canvas.toDataURL('image/png'), timeSeconds: video.currentTime })
      setRegion(null)
      setError('')
      setStatus('Frame captured. Optionally select a region. The video is unchanged.')
    } catch {
      setError('This source does not allow frame capture. You can still send timestamped feedback.')
    }
  }

  function pointerPosition(event: PointerEvent<HTMLDivElement>): { x: number; y: number } {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) / bounds.width * (frame?.canvas.width ?? 0),
      y: (event.clientY - bounds.top) / bounds.height * (frame?.canvas.height ?? 0)
    }
  }

  function moveRegion(event: PointerEvent<HTMLDivElement>): void {
    if (!frame || dragRef.current?.pointerId !== event.pointerId) return
    setRegion(reviewRegionFromDrag(dragRef.current.start, pointerPosition(event), frame.canvas.width, frame.canvas.height))
  }

  function changeRegion(edge: keyof VideoReviewRegion, value: number): void {
    if (!frame || !Number.isFinite(value)) return
    const width = frame.canvas.width
    const height = frame.canvas.height
    const next = { ...(region ?? { x: 0, y: 0, width, height }), [edge]: Math.round(value) }
    next.x = Math.max(0, Math.min(width - 1, next.x))
    next.y = Math.max(0, Math.min(height - 1, next.y))
    next.width = Math.max(1, Math.min(width - next.x, next.width))
    next.height = Math.max(1, Math.min(height - next.y, next.height))
    setRegion(next)
  }

  async function send(kind: 'feedback' | 'frame'): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setStatus('')
    try {
      if (kind === 'feedback') {
        await onFeedback(formatVideoReviewFeedback({ clipId, revision, name, text, range, duration }))
        if (mountedRef.current) {
          setText('')
          setStatus('Feedback sent. No edits have been applied to the video.')
        }
      } else {
        if (!frame || !onFrame) throw new Error('Frame sharing is not connected.')
        const source = frame.canvas
        let dataUrl = frame.dataUrl
        if (region) {
          const crop = document.createElement('canvas')
          crop.width = region.width
          crop.height = region.height
          const context = crop.getContext('2d')
          if (!context) throw new Error('Frame cropping is unavailable.')
          context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
          dataUrl = crop.toDataURL('image/png')
        }
        await onFrame({
          clipId, ...(revision !== undefined ? { revision } : {}),
          dataUrl, timeSeconds: frame.timeSeconds,
          width: region?.width ?? source.width, height: region?.height ?? source.height,
          sourceWidth: source.width, sourceHeight: source.height,
          ...(region ? { region: { ...region } } : {})
        })
        if (mountedRef.current) setStatus('Frame shared. No edits have been applied to the video.')
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'Could not send. Your draft is preserved; try again.')
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  return (
    <section className="video-review" aria-label={`Review ${name}`} aria-busy={busy}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
      }}>
      <header className="video-review-heading">
        <strong>{name}</strong>
        {revision !== undefined && <span>Revision {revision}</span>}
      </header>
      <video ref={videoRef} src={src} controls playsInline preload="metadata" aria-label={name}
        onLoadedMetadata={(event) => {
          const loadedDuration = event.currentTarget.duration
          if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) {
            setMediaError('This video has no finite duration and cannot be reviewed.')
            return
          }
          setDuration(loadedDuration)
          setRange({ startSeconds: 0, endSeconds: loadedDuration })
          setMediaError('')
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { if (loop && canLoop) { seek(range.startSeconds); void play() } }}
        onError={() => { setMediaError('The video could not be loaded. Check the attachment URL and supported format.'); setPlaying(false) }}
      />
      {mediaError && <p className="video-review-error" role="alert">{mediaError}</p>}
      <div className="video-review-transport">
        <button type="button" disabled={!ready} onClick={() => playing ? videoRef.current?.pause() : void play()}>{playing ? 'Pause' : 'Play'}</button>
        <output aria-label="Playback position">{formatReviewTime(time)} / {formatReviewTime(duration)}</output>
        <button type="button" disabled={!ready || busy} onClick={captureFrame}>Capture frame</button>
      </div>
      <label className="video-review-scrub">
        <span>Playhead</span>
        <input type="range" min={0} max={duration || 0} step="0.001" value={Math.min(time, duration)} disabled={!ready}
          aria-valuetext={formatReviewTime(time)} onChange={(event) => seek(event.currentTarget.valueAsNumber)} />
      </label>
      <fieldset className="video-review-range" disabled={!ready || busy}>
        <legend>Feedback range · seconds</legend>
        {(['startSeconds', 'endSeconds'] as const).map((edge) => (
          <div className="video-review-edge" key={edge}>
            <label htmlFor={`${id}-${edge}`}>{edge === 'startSeconds' ? 'Start' : 'End'}</label>
            <input id={`${id}-${edge}`} type="number" min={0} max={duration} step="0.001" value={range[edge]}
              onChange={(event) => setRange(updateReviewRange(range, edge, event.currentTarget.valueAsNumber, duration))} />
            <button type="button" onClick={() => setRange(updateReviewRange(range, edge, videoRef.current?.currentTime ?? time, duration))}>Use playhead for {edge === 'startSeconds' ? 'start' : 'end'}</button>
          </div>
        ))}
        <div className="video-review-range-actions">
          <label><input type="checkbox" checked={loop} disabled={!canLoop} onChange={(event) => setLoop(event.currentTarget.checked)} /> Loop selected range</label>
          <button type="button" onClick={() => { seek(range.startSeconds); void play() }}>Play from start</button>
        </div>
        <span className="video-review-hint">{formatReviewTime(range.startSeconds)} – {formatReviewTime(range.endSeconds)}{!canLoop ? ' · A single timestamp; select an end to loop.' : ''}</span>
      </fieldset>
      {frame && <fieldset className="video-review-capture" disabled={busy}>
        <legend>Frame at {formatReviewTime(frame.timeSeconds)}</legend>
        <p className="video-review-hint">Drag to select a region, or use the pixel controls. {onFrame ? 'Share the frame separately from text feedback.' : 'Frame preview only; attachment sharing is not connected.'}</p>
        <div className="video-review-frame" style={{ pointerEvents: busy ? 'none' : undefined }}
          onPointerDown={(event) => {
            if (event.button !== 0 || busy || dragRef.current) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { pointerId: event.pointerId, start: pointerPosition(event), previous: region }
          }}
          onPointerMove={moveRegion}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            moveRegion(event)
            dragRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { if (dragRef.current) setRegion(dragRef.current.previous); dragRef.current = null }}
          onLostPointerCapture={() => { if (dragRef.current) setRegion(dragRef.current.previous); dragRef.current = null }}>
          <img src={frame.dataUrl} alt={`Captured frame from ${name} at ${formatReviewTime(frame.timeSeconds)}`} draggable={false} />
          {region && <div className="video-review-region" style={{ left: `${region.x / frame.canvas.width * 100}%`, top: `${region.y / frame.canvas.height * 100}%`, width: `${region.width / frame.canvas.width * 100}%`, height: `${region.height / frame.canvas.height * 100}%` }} />}
        </div>
        <div className="video-review-region-fields">
          {(['x', 'y', 'width', 'height'] as const).map((edge) => <label key={edge}>
            {edge === 'x' ? 'Left' : edge === 'y' ? 'Top' : edge === 'width' ? 'Width' : 'Height'} (px)
            <input type="number" step={1} min={edge === 'x' || edge === 'y' ? 0 : 1}
              max={edge === 'x' ? frame.canvas.width - 1 : edge === 'y' ? frame.canvas.height - 1 : edge === 'width' ? frame.canvas.width - (region?.x ?? 0) : frame.canvas.height - (region?.y ?? 0)}
              value={region?.[edge] ?? (edge === 'width' ? frame.canvas.width : edge === 'height' ? frame.canvas.height : 0)}
              onChange={(event) => changeRegion(edge, event.currentTarget.valueAsNumber)} />
          </label>)}
        </div>
        <div className="video-review-range-actions">
          {onFrame && <button type="button" onClick={() => void send('frame')}>Share frame</button>}
          <button type="button" onClick={() => setRegion(null)}>Use full frame</button>
          <button type="button" onClick={() => { setFrame(null); setRegion(null) }}>Remove frame</button>
        </div>
      </fieldset>}
      <div className="video-review-feedback">
        <label htmlFor={`${id}-feedback`}>Feedback for selected range</label>
        <textarea id={`${id}-feedback`} rows={3} value={text} disabled={busy}
          placeholder="Describe what should change…" onChange={(event) => { setText(event.currentTarget.value); setStatus('') }} />
        <button className="video-review-send" type="button" disabled={!ready || !clipId.trim() || !text.trim() || busy}
          onClick={() => void send('feedback')}>{busy ? 'Sending…' : 'Send feedback'}</button>
      </div>
      {error && <p className="video-review-error" role="alert">{error}</p>}
      <p className="video-review-status" role="status">{status}</p>
    </section>
  )
}

export default VideoReview
