import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { CraftEmbedCard } from '@shared/cards'
import { cleanError, type CardActions } from './useCards'
import { loadVisualFrame, markedVisualFrame, sendCraftVisualReview, validVisualMark, visualMarkPath, visualPoint, type VisualMark } from './CraftVisualReview.helpers'
import './CraftVisualReview.css'

export interface CraftVisualReviewProps {
  card: CraftEmbedCard
  a: CardActions
  initialFrame: string
  onClose?: () => void
  onRecapture?: () => Promise<string | null>
}

export default function CraftVisualReview(props: CraftVisualReviewProps): ReactNode {
  return <VisualReviewSession key={`${props.card.brandId}:${props.card.id}:${props.card.projectId}:${props.card.appId}:${props.initialFrame}`} {...props} />
}

function VisualReviewSession({ card, a, initialFrame, onClose, onRecapture }: CraftVisualReviewProps): ReactNode {
  const id = useId()
  const [frame, setFrame] = useState<{ src: string; width: number; height: number; card: CraftEmbedCard } | null>(null)
  const [marks, setMarks] = useState<VisualMark[]>([])
  const [drawing, setDrawing] = useState<VisualMark | null>(null)
  const [tool, setTool] = useState<VisualMark['tool']>('circle')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const alive = useRef(true)
  const active = useRef<{ pointerId: number; mark: VisualMark } | null>(null)

  useEffect(() => {
    let cancelled = false
    alive.current = true
    const captureCard = { ...card }
    void loadVisualFrame(initialFrame).then((image) => {
      if (!cancelled) setFrame({ src: initialFrame, width: image.naturalWidth, height: image.naturalHeight, card: captureCard })
    }).catch((err) => { if (!cancelled) setError(cleanError(err)) })
    return () => { cancelled = true; alive.current = false }
  }, [])

  const pointAt = (event: PointerEvent<SVGSVGElement>) => visualPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
  const cancelStroke = (): void => {
    active.current = null
    setDrawing(null)
  }
  const move = (event: PointerEvent<SVGSVGElement>): void => {
    const stroke = active.current
    const point = pointAt(event)
    if (!stroke || event.pointerId !== stroke.pointerId || !point) return
    stroke.mark = { tool: stroke.mark.tool, points: stroke.mark.tool === 'circle' ? [stroke.mark.points[0], point] : [...stroke.mark.points, point] }
    setDrawing(stroke.mark)
  }
  const finish = (event: PointerEvent<SVGSVGElement>): void => {
    if (active.current?.pointerId !== event.pointerId) return
    move(event)
    const mark = active.current.mark
    if (validVisualMark(mark)) setMarks((previous) => [...previous, mark])
    cancelStroke()
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const recapture = async (): Promise<void> => {
    if (!onRecapture || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    const captureCard = { ...card }
    try {
      const src = await onRecapture()
      const image = await loadVisualFrame(src ?? '')
      if (!alive.current) return
      setFrame({ src: src!, width: image.naturalWidth, height: image.naturalHeight, card: captureCard })
      setMarks([])
      cancelStroke()
      setSent(false)
    } catch (err) {
      if (alive.current) setError(cleanError(err))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const send = async (): Promise<void> => {
    if (!frame || !text.trim() || pending.current || active.current || sent || !a.hasAgent) return
    if (a.brand.id !== frame.card.brandId) {
      setError('This screenshot belongs to another brand. Return to its chat before sending.')
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const png = await markedVisualFrame(frame.src, marks)
      if (!alive.current) return
      const projectName = a.brand.projects.find((project) => project.id === frame.card.projectId)?.name ?? ''
      await sendCraftVisualReview(frame.card, projectName, text, png, a.sendToAgent)
      if (alive.current) setSent(true)
    } catch (err) {
      if (alive.current) setError(cleanError(err))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const lineWidth = Math.max(2, (frame?.width ?? 800) / 400)
  return (
    <section className="cx-visual-review" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h4 id={`${id}-title`}>Circle what should change in {card.appName}</h4>
      <p id={`${id}-help`}>Mark this captured screenshot and describe the change. This does not draw on or modify your editor project.</p>
      <div className="cx-visual-review-tools" role="group" aria-label="Screenshot markup">
        <button type="button" aria-pressed={tool === 'circle'} disabled={!frame || busy || sent} onClick={() => setTool('circle')}>Circle / ellipse</button>
        <button type="button" aria-pressed={tool === 'freehand'} disabled={!frame || busy || sent} onClick={() => setTool('freehand')}>Freehand</button>
        <button type="button" disabled={!marks.length || busy || sent} onClick={() => setMarks((previous) => previous.slice(0, -1))}>Undo mark</button>
        <button type="button" disabled={!marks.length || busy || sent} onClick={() => { setMarks([]); cancelStroke() }}>Clear marks</button>
        {onRecapture && <button type="button" disabled={busy} onClick={() => void recapture()}>Capture again</button>}
      </div>
      {frame && (
        <div className="cx-visual-review-image">
          <img src={frame.src} alt={`${card.appName} screenshot for visual feedback`} draggable={false} />
          <svg viewBox={`0 0 ${frame.width} ${frame.height}`} aria-label="Draw circles or freehand marks on the screenshot" aria-describedby={`${id}-help`}
            onPointerDown={(event) => {
              if (event.button !== 0 || busy || sent || active.current) return
              const point = pointAt(event)
              if (!point) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              const mark = { tool, points: [point] }
              active.current = { pointerId: event.pointerId, mark }
              setDrawing(mark)
            }}
            onPointerMove={move} onPointerUp={finish}
            onPointerCancel={cancelStroke} onLostPointerCapture={cancelStroke}>
            {[...marks, ...(drawing ? [drawing] : [])].map((mark, index) => (
              <g key={index} fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d={visualMarkPath(mark, frame.width, frame.height)} stroke="#111111" strokeWidth={lineWidth * 2} />
                <path d={visualMarkPath(mark, frame.width, frame.height)} stroke="#ffffff" strokeWidth={lineWidth} />
              </g>
            ))}
          </svg>
        </div>
      )}
      {!frame && !error && <p role="status">Loading captured screenshot...</p>}
      <label htmlFor={`${id}-text`}>What should change?</label>
      <textarea id={`${id}-text`} rows={3} maxLength={2000} value={text} disabled={busy || sent}
        placeholder="Change this circled area..." onChange={(event) => setText(event.currentTarget.value)} />
      <p className="cx-visual-review-hint">Drawing is optional. You can also describe the change without marks.</p>
      {!a.hasAgent && <p>Set up an agent to send visual feedback.</p>}
      {error && <p className="cx-visual-review-error" role="alert">{error}</p>}
      {sent && <p role="status">Screenshot and feedback sent to your agent.</p>}
      <div className="cx-visual-review-actions">
        {onClose && <button type="button" disabled={busy} onClick={onClose}>{sent ? 'Close review' : 'Cancel'}</button>}
        <button type="button" className="primary" disabled={!frame || !text.trim() || busy || sent || !!drawing || !a.hasAgent || a.brand.id !== card.brandId} onClick={() => void send()}>
          {busy ? 'Preparing feedback...' : sent ? 'Sent' : 'Send screenshot and feedback'}
        </button>
      </div>
    </section>
  )
}
