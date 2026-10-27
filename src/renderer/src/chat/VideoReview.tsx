import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import type { ReviewBox, ReviewComment } from '@shared/cards'
import { reviewTime } from '@shared/cards'
import { clampReviewTime, reviewLoopTarget, reviewRegionFromDrag, type VideoReviewRange } from './VideoReview.helpers'
import './VideoReview.css'

export type { VideoReviewFrame, VideoReviewRange, VideoReviewRegion } from './VideoReview.helpers'

// a comment before it goes out: the frame (with the box outlined on it) is still a data url,
// the card saves it in main and swaps in the frame id
export interface DraftComment extends ReviewComment {
  frameDataUrl?: string
}

export interface VideoReviewProps {
  src: string
  name: string
  // the part the agent pointed at, highlighted to start with
  initialRange?: { from: number | null; to: number | null } | null
  onSend: (comments: DraftComment[]) => Promise<void>
  // extra buttons next to the transport, e.g. open in FilmCraft
  actions?: (time: number) => ReactNode
  sendLabel?: string
}

// the highlight drawn on the timeline, null for none
type Mark = VideoReviewRange | null

export function VideoReview(props: VideoReviewProps): ReactNode {
  return <VideoReviewSession key={props.src} {...props} />
}

// the frame as a png with the box outlined, white with a dark edge so it shows on anything
function grabFrame(video: HTMLVideoElement, box: ReviewBox | null): string | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0)
  if (box) {
    const line = Math.max(2, Math.round(canvas.width / 400))
    ctx.lineWidth = line * 2
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
    ctx.strokeRect(box.x, box.y, box.width, box.height)
    ctx.lineWidth = line
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(box.x, box.y, box.width, box.height)
  }
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

function VideoReviewSession({ src, name, initialRange, onSend, actions, sendLabel }: VideoReviewProps): ReactNode {
  const id = useId()
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; start: number; moved: boolean } | null>(null)
  const boxDrag = useRef<{ pointerId: number; start: { x: number; y: number } } | null>(null)
  const alive = useRef(true)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [mark, setMark] = useState<Mark>(null)
  const [loop, setLoop] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [box, setBox] = useState<ReviewBox | null>(null)
  const [withFrame, setWithFrame] = useState(false)
  const [text, setText] = useState('')
  const [comments, setComments] = useState<DraftComment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const ready = duration > 0
  const canLoop = !!mark && mark.endSeconds > mark.startSeconds

  useEffect(() => () => void (alive.current = false), [])

  // stays inside the highlight while loop is on
  useEffect(() => {
    if (!loop || !playing || !mark || !canLoop) return
    let req = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v && !v.paused && !v.seeking) {
        const t = reviewLoopTarget(v.currentTime, mark)
        if (t !== null) v.currentTime = t
      }
      req = requestAnimationFrame(tick)
    }
    req = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(req)
  }, [loop, playing, mark, canLoop])

  const seek = (t: number): void => {
    const v = videoRef.current
    if (!v || !ready) return
    v.currentTime = clampReviewTime(t, duration)
    setTime(v.currentTime)
  }

  const play = async (): Promise<void> => {
    const v = videoRef.current
    if (!v) return
    setDrawing(false)
    if (loop && mark && canLoop) {
      const t = reviewLoopTarget(v.currentTime, mark)
      if (t !== null) v.currentTime = t
    }
    await v.play().catch(() => alive.current && setError("This video won't play here. It may use a format the app can't show."))
  }

  const pause = (): void => videoRef.current?.pause()

  // ---- the timeline: click to seek, drag to highlight a range ----
  const timeAt = (e: PointerEvent<HTMLDivElement>): number => {
    const r = (trackRef.current ?? e.currentTarget).getBoundingClientRect()
    return clampReviewTime(((e.clientX - r.left) / Math.max(1, r.width)) * duration, duration)
  }
  const onTrackDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!ready || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, start: timeAt(e), moved: false }
  }
  const onTrackMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const t = timeAt(e)
    if (!d.moved && Math.abs(t - d.start) < duration / 200) return
    d.moved = true
    setMark({ startSeconds: Math.min(d.start, t), endSeconds: Math.max(d.start, t) })
  }
  const onTrackUp = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    if (!d.moved) seek(timeAt(e))
    else {
      const t = timeAt(e)
      seek(Math.min(d.start, t))
    }
  }

  // ---- the box on a paused frame ----
  const boxPoint = (e: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const v = videoRef.current!
    const r = e.currentTarget.getBoundingClientRect()
    // the video keeps its aspect inside the element, find the picture's own rect
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight)
    const w = v.videoWidth * scale
    const h = v.videoHeight * scale
    const left = r.left + (r.width - w) / 2
    const top = r.top + (r.height - h) / 2
    return { x: ((e.clientX - left) / w) * v.videoWidth, y: ((e.clientY - top) / h) * v.videoHeight }
  }
  const boxStyle = (): CSSProperties | undefined => {
    const v = videoRef.current
    if (!box || !v || !v.videoWidth) return undefined
    const r = v.getBoundingClientRect()
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight)
    const offX = (r.width - v.videoWidth * scale) / 2
    const offY = (r.height - v.videoHeight * scale) / 2
    return { left: offX + box.x * scale, top: offY + box.y * scale, width: box.width * scale, height: box.height * scale }
  }

  const addComment = (): void => {
    const v = videoRef.current
    const body = text.trim()
    if (!v || !body || !ready) return
    const from = mark ? mark.startSeconds : v.currentTime
    const to = mark ? mark.endSeconds : v.currentTime
    const c: DraftComment = { from, to, text: body }
    if (box || withFrame) {
      if (!mark) v.pause()
      const url = grabFrame(v, box)
      if (url) {
        c.frameDataUrl = url
        c.box = box
        c.frameWidth = v.videoWidth
        c.frameHeight = v.videoHeight
      } else setError("The frame couldn't be captured, the comment goes without it.")
    }
    setComments((list) => [...list, c].sort((a, b) => a.from - b.from))
    setText('')
    setBox(null)
    setDrawing(false)
    setWithFrame(false)
    setStatus('')
  }

  const sendAll = async (): Promise<void> => {
    if (!comments.length || busy) return
    setBusy(true)
    setError('')
    try {
      await onSend(comments)
      if (!alive.current) return
      setComments([])
      setStatus('Sent to your agent. Nothing in the video changed yet.')
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : "Couldn't send. Your comments are still here.")
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const pct = (t: number): string => `${ready ? (t / duration) * 100 : 0}%`

  return (
    <section className="video-review" aria-label={`Review ${name}`} aria-busy={busy} onKeyDown={(e) => e.stopPropagation()}>
      <div className={`video-review-stage${drawing ? ' drawing' : ''}`}>
        <video
          ref={videoRef}
          src={src}
          playsInline
          preload="metadata"
          aria-label={name}
          crossOrigin="anonymous"
          onClick={() => (drawing ? undefined : playing ? pause() : void play())}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (!Number.isFinite(d) || d <= 0) {
              setError("This file has no length the app can read, so it can't be reviewed.")
              return
            }
            setDuration(d)
            const f = initialRange?.from
            const t = initialRange?.to
            if (typeof f === 'number') {
              const a = clampReviewTime(f, d)
              const b = typeof t === 'number' ? clampReviewTime(t, d) : a
              if (b > a) setMark({ startSeconds: a, endSeconds: b })
              e.currentTarget.currentTime = a
            }
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            setPlaying(false)
            setError("The video couldn't be loaded. It may have moved or use a format the app can't play.")
          }}
        />
        {drawing && (
          <div
            className="video-review-draw"
            aria-label="Drag to draw a box on the frame"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              boxDrag.current = { pointerId: e.pointerId, start: boxPoint(e) }
            }}
            onPointerMove={(e) => {
              const b = boxDrag.current
              const v = videoRef.current
              if (!b || b.pointerId !== e.pointerId || !v) return
              const r = reviewRegionFromDrag(b.start, boxPoint(e), v.videoWidth, v.videoHeight)
              if (r) setBox(r)
            }}
            onPointerUp={() => {
              boxDrag.current = null
            }}
          />
        )}
        {box && <div className="video-review-box" style={boxStyle()} />}
      </div>

      <div className="video-review-transport">
        <button type="button" disabled={!ready} onClick={() => (playing ? pause() : void play())}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <output aria-label="Playback position" className="video-review-time">
          {reviewTime(time)} of {reviewTime(duration)}
        </output>
        <span className="spacer" />
        {actions?.(time)}
      </div>

      <div
        ref={trackRef}
        className="video-review-track"
        role="slider"
        tabIndex={0}
        aria-label="Timeline. Click to jump, drag to highlight a part"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={time}
        aria-valuetext={reviewTime(time)}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seek(time + (e.shiftKey ? 1 : 1 / 30))
          else if (e.key === 'ArrowLeft') seek(time - (e.shiftKey ? 1 : 1 / 30))
          else if (e.key === ' ') {
            e.preventDefault()
            if (playing) pause()
            else void play()
          } else return
          e.preventDefault()
        }}
      >
        {mark && <div className="video-review-mark" style={{ left: pct(mark.startSeconds), width: `calc(${pct(mark.endSeconds)} - ${pct(mark.startSeconds)})` }} />}
        {comments.map((c, i) => (
          <div key={i} className="video-review-pin" style={{ left: pct(c.from) }} title={`${reviewTime(c.from)} ${c.text}`} />
        ))}
        <div className="video-review-head" style={{ left: pct(time) }} />
      </div>

      <div className="video-review-row">
        {mark ? (
          <>
            <span>
              Highlighted {reviewTime(mark.startSeconds)} to {reviewTime(mark.endSeconds)}
            </span>
            <label className="video-review-check">
              <input type="checkbox" checked={loop} disabled={!canLoop} onChange={(e) => setLoop(e.currentTarget.checked)} /> Loop it
            </label>
            <button type="button" onClick={() => setMark(null)}>
              Clear
            </button>
          </>
        ) : (
          <span className="video-review-hint">Drag on the timeline to highlight a part, or comment on the frame you're on.</span>
        )}
      </div>

      <div className="video-review-feedback">
        <label htmlFor={`${id}-comment`}>
          {mark ? `Comment on ${reviewTime(mark.startSeconds)} to ${reviewTime(mark.endSeconds)}` : `Comment at ${reviewTime(time)}`}
        </label>
        <textarea
          id={`${id}-comment`}
          rows={2}
          value={text}
          disabled={busy || !ready}
          placeholder="What should change here?"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              addComment()
            }
          }}
        />
        <div className="video-review-row">
          <button
            type="button"
            disabled={!ready || busy}
            aria-pressed={drawing}
            onClick={() => {
              if (!drawing) pause()
              setDrawing(!drawing)
            }}
          >
            {drawing ? 'Done drawing' : box ? 'Redraw box' : 'Draw a box'}
          </button>
          {box && (
            <button type="button" onClick={() => setBox(null)}>
              Remove box
            </button>
          )}
          <label className="video-review-check">
            <input type="checkbox" checked={withFrame || !!box} disabled={!!box} onChange={(e) => setWithFrame(e.currentTarget.checked)} /> Send the frame
          </label>
          <span className="spacer" />
          <button type="button" disabled={!text.trim() || !ready || busy} onClick={addComment}>
            Add comment
          </button>
        </div>
      </div>

      {comments.length > 0 && (
        <ol className="video-review-comments" aria-label="Your comments">
          {comments.map((c, i) => (
            <li key={i}>
              <button type="button" className="video-review-at" onClick={() => seek(c.from)} title="Jump there">
                {c.to > c.from ? `${reviewTime(c.from)} to ${reviewTime(c.to)}` : reviewTime(c.from)}
              </button>
              <span className="video-review-text">{c.text}</span>
              {c.frameDataUrl && <img src={c.frameDataUrl} alt={`Frame at ${reviewTime(c.from)}`} />}
              <button type="button" className="video-review-remove" aria-label="Remove comment" onClick={() => setComments((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {comments.length > 0 && (
        <div className="video-review-row">
          <span className="spacer" />
          <button type="button" className="video-review-send" disabled={busy} onClick={() => void sendAll()}>
            {busy ? 'Sending' : (sendLabel ?? `Send ${comments.length} comment${comments.length === 1 ? '' : 's'} to your agent`)}
          </button>
        </div>
      )}
      {error && (
        <p className="video-review-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="video-review-status" role="status">
          {status}
        </p>
      )}
    </section>
  )
}

export default VideoReview
