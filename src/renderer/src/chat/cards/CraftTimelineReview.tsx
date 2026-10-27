import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { CraftEmbedCard, ReviewBox } from '@shared/cards'
import { formatCraftReview, timecode, type CraftReviewItem, type EmbedSequence } from '@shared/craft-embed'
import { clampReviewTime, reviewRegionFromDrag } from '../VideoReview.helpers'
import { cleanError } from './useCards'

// comments on the FilmCraft sequence: highlight a part of its timeline (or take FilmCraft's
// playhead), draw a box on the frame, and on send each comment becomes a marker in the project at
// that time, then goes to the agent with the marker ids and the frames

interface Draft {
  from: number
  to: number
  text: string
  frame: string | null
  box: ReviewBox | null
  width: number
  height: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => fail(new Error("The frame couldn't be read."))
    img.src = src
  })
}

// the frame with the box outlined, white with a dark edge so it shows on anything
async function boxedFrame(src: string, box: ReviewBox | null): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  if (box) {
    const line = Math.max(2, Math.round(canvas.width / 400))
    ctx.lineWidth = line * 2
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
    ctx.strokeRect(box.x, box.y, box.width, box.height)
    ctx.lineWidth = line
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(box.x, box.y, box.width, box.height)
  }
  return canvas.toDataURL('image/png')
}

export default function CraftTimelineReview({
  brandId,
  card,
  projectName,
  send
}: {
  brandId: string
  card: CraftEmbedCard
  projectName: string
  send: ((text: string) => Promise<void>) | null
}): ReactNode {
  const id = useId()
  const api = window.trenddeckEmbed!
  const [seq, setSeq] = useState<EmbedSequence | null>(null)
  const [time, setTime] = useState(0)
  const [mark, setMark] = useState<{ from: number; to: number } | null>(null)
  const [text, setText] = useState('')
  const [frame, setFrame] = useState<{ src: string; width: number; height: number } | null>(null)
  const [box, setBox] = useState<ReviewBox | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const trackRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ start: number; moved: boolean } | null>(null)
  const boxDrag = useRef<{ x: number; y: number } | null>(null)
  const duration = seq?.durationSeconds ?? 0
  const tc = (s: number): string => timecode(s, seq?.fps)

  const refresh = async (): Promise<void> => {
    setError('')
    try {
      const s = await api.sequence(brandId, card.id)
      setSeq(s)
      if (!s) setError('FilmCraft has no sequence open. Open one there, then comment.')
      else if (s.playheadSeconds !== null) setTime(clampReviewTime(s.playheadSeconds, s.durationSeconds))
    } catch (err) {
      setError(cleanError(err))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const timeAt = (e: PointerEvent<HTMLDivElement>): number => {
    const r = (trackRef.current ?? e.currentTarget).getBoundingClientRect()
    return clampReviewTime(((e.clientX - r.left) / Math.max(1, r.width)) * duration, duration)
  }

  const grab = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const src = await api.still(brandId, card.id, mark ? mark.from : time)
      if (!src) throw new Error("FilmCraft didn't give a frame for that time.")
      const img = await loadImage(src)
      setFrame({ src, width: img.naturalWidth, height: img.naturalHeight })
      setBox(null)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const imgPoint = (e: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const r = imgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * frame!.width, y: ((e.clientY - r.top) / r.height) * frame!.height }
  }

  const add = (): void => {
    const body = text.trim()
    if (!body || !seq) return
    const from = mark ? mark.from : time
    const to = mark ? mark.to : time
    setDrafts((list) => [...list, { from, to, text: body, frame: frame?.src ?? null, box, width: frame?.width ?? 0, height: frame?.height ?? 0 }].sort((a, b) => a.from - b.from))
    setText('')
    setFrame(null)
    setBox(null)
    setDrawing(false)
    setStatus('')
  }

  const sendAll = async (): Promise<void> => {
    if (!drafts.length || busy || !send) return
    setBusy(true)
    setError('')
    try {
      const placed = await api.addMarkers(
        brandId,
        card.id,
        drafts.map((d) => ({ from: d.from, to: d.to, text: d.text }))
      )
      const items: CraftReviewItem[] = []
      for (let i = 0; i < placed.length; i++) {
        const d = drafts[i]
        const item: CraftReviewItem = { ...placed[i] }
        if (d?.frame) {
          item.frameId = await window.trenddeckCards.saveFrame(brandId, card.id, {
            dataUrl: await boxedFrame(d.frame, d.box),
            timeSeconds: d.from,
            width: d.width,
            height: d.height,
            box: d.box
          })
          item.box = d.box
          item.frameWidth = d.width
          item.frameHeight = d.height
        }
        items.push(item)
      }
      await send(formatCraftReview({ cardId: card.id, projectId: card.projectId, projectName, appName: card.appName, file: card.file }, items))
      const made = items.filter((i) => i.marker !== null).length
      setDrafts([])
      setStatus(`${made} marker${made === 1 ? '' : 's'} added in FilmCraft and sent to your agent.`)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const pct = (t: number): string => `${duration ? (t / duration) * 100 : 0}%`
  const boxStyle = box && frame ? { left: `${(box.x / frame.width) * 100}%`, top: `${(box.y / frame.height) * 100}%`, width: `${(box.width / frame.width) * 100}%`, height: `${(box.height / frame.height) * 100}%` } : undefined

  return (
    <section className="cx-embed-review" aria-label="Comment on the FilmCraft timeline" onKeyDown={(e) => e.stopPropagation()}>
      <div className="cx-card2-actions">
        <span className="muted">{seq ? `${seq.name}, ${tc(duration)} long` : 'Reading the sequence'}</span>
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => void refresh()} title="Moves the comment point to where FilmCraft's playhead is">
          Use FilmCraft's playhead
        </button>
      </div>
      <div
        ref={trackRef}
        className="cx-embed-track"
        role="slider"
        tabIndex={0}
        aria-label="Sequence timeline. Click to pick a time, drag to highlight a part"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={time}
        aria-valuetext={tc(time)}
        onPointerDown={(e) => {
          if (!duration || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { start: timeAt(e), moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const t = timeAt(e)
          if (!d.moved && Math.abs(t - d.start) < duration / 200) return
          d.moved = true
          setMark({ from: Math.min(d.start, t), to: Math.max(d.start, t) })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (!d) return
          if (!d.moved) {
            setMark(null)
            setTime(timeAt(e))
          } else setTime(Math.min(d.start, timeAt(e)))
        }}
        onKeyDown={(e) => {
          const step = seq ? seq.fps.den / seq.fps.num : 1 / 30
          if (e.key === 'ArrowRight') setTime(clampReviewTime(time + (e.shiftKey ? 1 : step), duration))
          else if (e.key === 'ArrowLeft') setTime(clampReviewTime(time - (e.shiftKey ? 1 : step), duration))
          else return
          e.preventDefault()
        }}
      >
        {mark && <div className="cx-embed-mark" style={{ left: pct(mark.from), width: `calc(${pct(mark.to)} - ${pct(mark.from)})` }} />}
        {drafts.map((d, i) => (
          <div key={i} className="cx-embed-pin" style={{ left: pct(d.from) }} title={`${tc(d.from)} ${d.text}`} />
        ))}
        <div className="cx-embed-head" style={{ left: pct(time) }} />
      </div>
      <div className="cx-card2-actions">
        <span>{mark ? `${tc(mark.from)} to ${tc(mark.to)}` : `At ${tc(time)}`}</span>
        {mark && (
          <button type="button" onClick={() => setMark(null)}>
            Clear highlight
          </button>
        )}
        <span className="spacer" />
        <button type="button" disabled={busy || !seq} onClick={() => void grab()}>
          {frame ? 'Grab again' : 'Grab the frame'}
        </button>
      </div>
      {frame && (
        <div className={`cx-embed-frame${drawing ? ' drawing' : ''}`}>
          <img ref={imgRef} src={frame.src} alt={`Frame at ${tc(mark ? mark.from : time)}`} />
          {drawing && (
            <div
              className="cx-embed-draw"
              aria-label="Drag to draw a box on the frame"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.currentTarget.setPointerCapture(e.pointerId)
                boxDrag.current = imgPoint(e)
              }}
              onPointerMove={(e) => {
                if (!boxDrag.current) return
                const r = reviewRegionFromDrag(boxDrag.current, imgPoint(e), frame.width, frame.height)
                if (r) setBox(r)
              }}
              onPointerUp={() => (boxDrag.current = null)}
            />
          )}
          {boxStyle && <div className="cx-embed-box" style={boxStyle} />}
        </div>
      )}
      <label htmlFor={`${id}-text`} className="muted">
        {mark ? `Comment on ${tc(mark.from)} to ${tc(mark.to)}` : `Comment at ${tc(time)}`}
      </label>
      <div className="cx-card2-reply">
        <textarea
          id={`${id}-text`}
          rows={2}
          value={text}
          disabled={busy || !seq}
          placeholder="What should change here?"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
      <div className="cx-card2-actions">
        {frame && (
          <button type="button" aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>
            {drawing ? 'Done drawing' : box ? 'Redraw box' : 'Draw a box'}
          </button>
        )}
        {frame && (
          <button type="button" onClick={() => (setFrame(null), setBox(null), setDrawing(false))}>
            Leave the frame out
          </button>
        )}
        <span className="spacer" />
        <button type="button" disabled={!text.trim() || !seq || busy} onClick={add}>
          Add comment
        </button>
      </div>
      {drafts.length > 0 && (
        <ol className="cx-embed-comments" aria-label="Your comments">
          {drafts.map((d, i) => (
            <li key={i}>
              <span className="cx-embed-at">{d.to > d.from ? `${tc(d.from)} to ${tc(d.to)}` : tc(d.from)}</span>
              <span>{d.text}</span>
              {d.frame && <img src={d.frame} alt={`Frame at ${tc(d.from)}`} />}
              <button type="button" aria-label="Remove comment" onClick={() => setDrafts((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {drafts.length > 0 && (
        <div className="cx-card2-actions">
          <span className="spacer" />
          <button type="button" className="primary" disabled={busy || !send} onClick={() => void sendAll()}>
            {busy ? 'Adding markers' : `Add ${drafts.length} marker${drafts.length === 1 ? '' : 's'} and send to your agent`}
          </button>
        </div>
      )}
      {!send && <p className="cx-card2-note">Set up an agent to send comments.</p>}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="cx-card2-note" role="status">
          {status}
        </p>
      )}
    </section>
  )
}
