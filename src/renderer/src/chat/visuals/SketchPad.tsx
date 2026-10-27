import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { VisualAsset } from '@shared/visuals'
import { Dropdown } from '../ui'
import { embedFor, useEmbeds } from '../cards/embed-owner'
import { cleanError, type CardActions } from '../cards/useCards'
import {
  commit,
  describeShapes,
  drawSketch,
  emptyHistory,
  erase,
  fitPicture,
  MARKERS,
  PAGES,
  redo,
  sketchName,
  SKETCH_TOOLS,
  strokeFor,
  textSizeFor,
  toDoc,
  TOOL_NAMES,
  undo,
  validShape,
  type Ctx,
  type PageName,
  type Pt,
  type Shape,
  type SketchDoc,
  type SketchTool,
  type WidthName
} from './sketch'
import type { SketchRequest } from './actions'
import VisualActions from './VisualActions'
import './visuals.css'

// draw on a blank page, a frame from the Craft editor in the chat, a pasted screenshot or any image
// in the chat, then send it to your agent, add it to the video files or place it in an editor.
// the drawing is plain shapes until one of those, then it's saved as a png

const loadPicture = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    if (src.startsWith('td-media:')) img.crossOrigin = 'anonymous'
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error('That picture is empty.')))
    img.onerror = () => reject(new Error("That picture couldn't be loaded."))
    img.src = src
  })

const readFile = (f: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("That file couldn't be read."))
    r.readAsDataURL(f)
  })

function ToolIcon({ tool }: { tool: SketchTool }): ReactNode {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {tool === 'pen' && <path {...p} d="M2.5 13.5c2-1 3-4 5-6s4-3 6-4.5" />}
      {tool === 'line' && <path {...p} d="M3 13L13 3" />}
      {tool === 'arrow' && <path {...p} d="M3 13L13 3M7.5 3H13v5.5" />}
      {tool === 'box' && <rect {...p} x="2.5" y="3.5" width="11" height="9" rx="0.5" />}
      {tool === 'ellipse' && <ellipse {...p} cx="8" cy="8" rx="5.5" ry="4.5" />}
      {tool === 'text' && <path {...p} d="M3 3.5h10M8 3.5v9.5M6 13h4" />}
      {tool === 'eraser' && <path {...p} d="M6 13.5h7.5M3 10l5.5-6.5 4 3.5L8 13.5H6z" />}
    </svg>
  )
}

export default function SketchPad({ a, start, onClose }: { a: CardActions; start: SketchRequest | null; onClose: () => void }): ReactNode {
  const id = useId()
  const [doc, setDoc] = useState<SketchDoc>({ ...PAGES.wide, paper: '#f5f5f5', shapes: [] })
  const [page, setPage] = useState<PageName>('wide')
  const [picture, setPicture] = useState<{ img: HTMLImageElement; name: string; frame: boolean } | null>(null)
  const [tool, setTool] = useState<SketchTool>('pen')
  const [color, setColor] = useState<string>(MARKERS[0].value)
  const [size, setSize] = useState<WidthName>('medium')
  const [history, setHistory] = useState(emptyHistory)
  const [live, setLive] = useState<Shape | null>(null)
  const [typing, setTyping] = useState<{ at: Pt; text: string } | null>(null)
  const [note, setNote] = useState(start?.note ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<{ pointer: number; shape: Shape; before: Shape[] } | null>(null)
  const saved = useRef<{ key: string; asset: VisualAsset } | null>(null)
  const textBox = useRef<HTMLInputElement>(null)
  useEmbeds()
  const embed = a.project ? embedFor(a.project.id) : null

  // a fresh picture under the drawing: the page takes its size, the shapes go
  const usePicture = useCallback(async (src: string, name: string, frame = false): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const img = await loadPicture(src)
      const fit = fitPicture(img.naturalWidth, img.naturalHeight)
      setPicture({ img, name, frame })
      setDoc({ ...fit, paper: null, shapes: [] })
      setHistory(emptyHistory())
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (start?.src) void usePicture(start.src, start.name)
  }, [start, usePicture])

  const blank = (p: PageName): void => {
    setPage(p)
    setPicture(null)
    setDoc({ width: PAGES[p].width, height: PAGES[p].height, paper: '#f5f5f5', shapes: [] })
    setHistory(emptyHistory())
  }

  // redraw on every change
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, doc.width, doc.height)
    drawSketch(ctx as unknown as Ctx, doc, picture?.img ?? null, live)
  }, [doc, picture, live])

  const change = (shapes: Shape[], before: Shape[]): void => {
    setHistory((h) => commit(h, before))
    setDoc((d) => ({ ...d, shapes }))
  }
  const doUndo = (): void => {
    const out = undo(history, doc.shapes)
    if (!out) return
    setHistory(out.history)
    setDoc((d) => ({ ...d, shapes: out.shapes }))
  }
  const doRedo = (): void => {
    const out = redo(history, doc.shapes)
    if (!out) return
    setHistory(out.history)
    setDoc((d) => ({ ...d, shapes: out.shapes }))
  }

  const commitText = (): void => {
    if (!typing) return
    const text = typing.text.trim()
    if (text) {
      const shape: Shape = { id: crypto.randomUUID(), tool: 'text', color, width: textSizeFor(size, doc), points: [typing.at], text }
      change([...doc.shapes, shape], doc.shapes)
    }
    setTyping(null)
  }

  // keys: undo, redo, close. not while typing in a box
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        doRedo()
      } else if (e.key === 'Escape' && !document.querySelector('.ui-pop')) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // a screenshot pasted while the pad is open goes under the drawing
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'))
      if (!f) return
      e.preventDefault()
      e.stopPropagation()
      void readFile(f).then((src) => usePicture(src, 'pasted screenshot'), (err: unknown) => setError(cleanError(err)))
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [usePicture])

  useEffect(() => {
    if (typing) textBox.current?.focus()
  }, [typing])

  const pointAt = (e: PointerEvent<HTMLCanvasElement>): Pt | null => toDoc(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), doc)

  const down = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 || active.current || loading) return
    const pt = pointAt(e)
    if (!pt) return
    e.preventDefault()
    if (typing) commitText()
    if (tool === 'text') {
      setTyping({ at: pt, text: '' })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const shape: Shape = { id: crypto.randomUUID(), tool: tool === 'eraser' ? 'pen' : tool, color, width: strokeFor(size, doc), points: [pt] }
    active.current = { pointer: e.pointerId, shape, before: doc.shapes }
    if (tool === 'eraser') setDoc((d) => ({ ...d, shapes: erase(d.shapes, [pt], strokeFor(size, d) * 2) }))
    else setLive(shape)
  }
  const move = (e: PointerEvent<HTMLCanvasElement>): void => {
    const cur = active.current
    if (!cur || cur.pointer !== e.pointerId) return
    const pt = pointAt(e)
    if (!pt) return
    if (tool === 'eraser') {
      setDoc((d) => ({ ...d, shapes: erase(d.shapes, [pt], strokeFor(size, d) * 2) }))
      return
    }
    cur.shape = { ...cur.shape, points: cur.shape.tool === 'pen' ? [...cur.shape.points, pt] : [cur.shape.points[0], pt] }
    setLive(cur.shape)
  }
  const up = (e: PointerEvent<HTMLCanvasElement>): void => {
    const cur = active.current
    if (!cur || cur.pointer !== e.pointerId) return
    active.current = null
    setLive(null)
    if (tool === 'eraser') {
      if (doc.shapes.length !== cur.before.length) setHistory((h) => commit(h, cur.before))
      return
    }
    const shape = cur.shape.tool === 'pen' && cur.shape.points.length === 1 ? { ...cur.shape, points: [cur.shape.points[0], cur.shape.points[0]] } : cur.shape
    if (validShape(shape)) change([...doc.shapes, shape], cur.before)
  }

  // the png of the drawing, saved once per version so several actions reuse it
  const save = async (): Promise<VisualAsset> => {
    if (typing) commitText()
    const key = `${doc.shapes.map((s) => s.id).join(',')}|${doc.width}x${doc.height}|${picture?.img.src.slice(-40) ?? 'blank'}|${note}`
    if (saved.current?.key === key) return saved.current.asset
    const out = document.createElement('canvas')
    out.width = doc.width
    out.height = doc.height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error("The drawing couldn't be saved. Try again.")
    drawSketch(ctx as unknown as Ctx, doc, picture?.img ?? null)
    const marks = describeShapes(doc.shapes)
    const what = picture ? `Drawn on ${picture.name}.` : 'Drawn on a blank page.'
    const asset = await window.trenddeckVisuals.saveImage({
      brandId: a.brand.id,
      threadId: a.threadId ?? null,
      dataUrl: out.toDataURL('image/png'),
      origin: picture?.frame ? 'frame' : 'sketch',
      name: sketchName(picture?.name ?? null).replace(/\.png$/, ''),
      note: [what, marks ? `Marks: ${marks}.` : '', note.trim()].filter(Boolean).join(' ')
    })
    saved.current = { key, asset }
    return asset
  }

  const frame = async (): Promise<void> => {
    if (!embed || !window.trenddeckEmbed) return
    setLoading(true)
    setError('')
    try {
      const src = await window.trenddeckEmbed.still(a.brand.id, embed.id)
      if (!src) throw new Error(`${embed.appName} has no frame to show right now. Open it in the chat, then try again.`)
      await usePicture(src, `a frame from ${embed.appName}`, true)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setLoading(false)
    }
  }

  const empty = !doc.shapes.length && !picture
  return (
    <div className="modal-backdrop vs-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="vs-pad" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <header className="vs-pad-head">
          <h2 id={`${id}-title`}>Sketch{picture ? ` on ${picture.name}` : ''}</h2>
          <span className="spacer" />
          <div className="vs-pad-sources" role="group" aria-label="What to draw on">
            <Dropdown
              label="Blank page"
              title="Start over on a blank page"
              value={picture ? '' : page}
              options={[
                ...(picture ? [{ value: '' as const, label: 'Blank page' }] : []),
                ...(Object.keys(PAGES) as PageName[]).map((p) => ({ value: p, label: `Blank ${PAGES[p].label}` }))
              ]}
              onChange={(p) => p && blank(p)}
            />
            {embed && (
              <button type="button" className="vs-btn" disabled={loading} onClick={() => void frame()}>
                Frame from {embed.appName}
              </button>
            )}
          </div>
          <button type="button" className="vs-btn" onClick={onClose} aria-label="Close sketch pad" title="Close (Esc)">
            Close
          </button>
        </header>

        <div className="vs-tools" role="toolbar" aria-label="Drawing tools">
          <div className="vs-tool-group" role="group" aria-label="Tool">
            {SKETCH_TOOLS.map((t) => (
              <button key={t} type="button" className="vs-btn vs-tool" aria-pressed={tool === t} title={TOOL_NAMES[t]} onClick={() => setTool(t)}>
                <ToolIcon tool={t} />
                <span>{TOOL_NAMES[t]}</span>
              </button>
            ))}
          </div>
          <div className="vs-tool-group" role="group" aria-label="Marker color">
            {MARKERS.map((m) => (
              <button
                key={m.value}
                type="button"
                className="vs-swatch"
                aria-pressed={color === m.value}
                aria-label={m.name}
                title={m.name}
                onClick={() => setColor(m.value)}
              >
                <span style={{ background: m.value }} />
              </button>
            ))}
          </div>
          <Dropdown
            label="Size"
            title="Line and text size"
            value={size}
            options={[
              { value: 'thin', label: 'Thin' },
              { value: 'medium', label: 'Medium' },
              { value: 'thick', label: 'Thick' }
            ]}
            onChange={setSize}
          />
          <span className="spacer" />
          <button type="button" className="vs-btn" disabled={!history.past.length} onClick={doUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="vs-btn" disabled={!history.future.length} onClick={doRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
          <button type="button" className="vs-btn" disabled={!doc.shapes.length} onClick={() => change([], doc.shapes)}>
            Clear
          </button>
        </div>

        <div
          className="vs-stage"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDrop={(e) => {
            const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'))
            if (!f) return
            e.preventDefault()
            e.stopPropagation()
            void readFile(f).then((src) => usePicture(src, f.name), (err: unknown) => setError(cleanError(err)))
          }}
        >
          <div className="vs-canvas-box" style={{ aspectRatio: `${doc.width} / ${doc.height}`, width: `min(100%, calc((100vh - 400px) * ${(doc.width / doc.height).toFixed(4)}))`, minWidth: 240 }}>
            <canvas
              ref={canvas}
              width={doc.width}
              height={doc.height}
              className={`vs-canvas tool-${tool}`}
              aria-label={`Drawing area, ${TOOL_NAMES[tool].toLowerCase()} selected`}
              aria-describedby={`${id}-help`}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => {
                active.current = null
                setLive(null)
              }}
            />
            {typing && (
              <input
                ref={textBox}
                className="vs-text-input"
                style={{ left: `${(typing.at.x / doc.width) * 100}%`, top: `${(typing.at.y / doc.height) * 100}%`, color }}
                value={typing.text}
                maxLength={200}
                aria-label="Text to add"
                placeholder="Type, then Enter"
                onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitText()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setTyping(null)
                  }
                }}
                onBlur={commitText}
              />
            )}
          </div>
        </div>
        <p id={`${id}-help`} className="vs-hint">
          {loading
            ? 'Loading the picture...'
            : 'Paste a screenshot (Ctrl+V) or drop an image here to draw on it. Your editor projects are not changed by drawing here.'}
        </p>
        {error && (
          <p className="cx-card2-error" role="alert">
            {error}
          </p>
        )}

        <label className="vs-note" htmlFor={`${id}-note`}>
          Note for your agent (optional)
        </label>
        <textarea
          id={`${id}-note`}
          className="vs-note-box"
          rows={2}
          maxLength={2000}
          value={note}
          placeholder="e.g. put the title here, cut out the background"
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="cx-card2 vs-pad-actions">
          {empty ? (
            <p className="cx-card2-note">Draw something or put a picture under the page first.</p>
          ) : (
            <VisualActions
              a={a}
              kind="image"
              draw={false}
              primary
              note={note}
              get={async () => ({ type: 'asset', asset: await save() })}
              onDone={(what) => {
                if (what === 'send' || what === 'insert' || what === 'photocraft') onClose()
              }}
            />
          )}
        </div>
      </section>
    </div>
  )
}
