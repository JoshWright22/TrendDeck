// the sketch pad's drawing: plain shapes in picture pixels, drawn the same way on screen and into
// the exported png. pure, no DOM, so it's unit tested with a fake canvas context

export const SKETCH_TOOLS = ['pen', 'line', 'arrow', 'box', 'ellipse', 'text', 'eraser'] as const
export type SketchTool = (typeof SKETCH_TOOLS)[number]
export type ShapeTool = Exclude<SketchTool, 'eraser'>

export const TOOL_NAMES: Record<SketchTool, string> = {
  pen: 'Pen',
  line: 'Line',
  arrow: 'Arrow',
  box: 'Box',
  ellipse: 'Ellipse',
  text: 'Text',
  eraser: 'Eraser'
}

// marker colors for what you draw. the pad's own buttons stay gray
export const MARKERS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'White', value: '#ffffff' },
  { name: 'Black', value: '#111111' }
] as const

export const WIDTHS = { thin: 1, medium: 2, thick: 4 } as const
export type WidthName = keyof typeof WIDTHS

export interface Pt {
  x: number
  y: number
}

export interface Shape {
  id: string
  tool: ShapeTool
  color: string
  // stroke width in picture pixels, text size for text
  width: number
  points: Pt[]
  text?: string
}

export interface SketchDoc {
  width: number
  height: number
  // fill for a blank page, null when there's a picture under it
  paper: string | null
  shapes: Shape[]
}

// blank page sizes
export const PAGES = {
  wide: { label: '16:9', width: 1280, height: 720 },
  tall: { label: '9:16', width: 720, height: 1280 },
  square: { label: '1:1', width: 1080, height: 1080 }
} as const
export type PageName = keyof typeof PAGES

export const PAPER = '#f5f5f5'
const MAX_SIDE = 2400

// a picture's size for the pad: big ones scaled down so the png stays a sensible size
export function fitPicture(w: number, h: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: PAGES.wide.width, height: PAGES.wide.height }
  const s = Math.min(1, MAX_SIDE / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

// line width that reads at this picture size: the base step times about 1/400 of the long side
export function strokeFor(name: WidthName, doc: Pick<SketchDoc, 'width' | 'height'>): number {
  return Math.max(2, Math.round(WIDTHS[name] * Math.max(doc.width, doc.height) / 400))
}

export function textSizeFor(name: WidthName, doc: Pick<SketchDoc, 'width' | 'height'>): number {
  return Math.round(Math.max(doc.width, doc.height) / ({ thin: 40, medium: 26, thick: 16 } as const)[name])
}

// a pointer position on the shown canvas as picture pixels, clamped to the picture
export function toDoc(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, doc: Pick<SketchDoc, 'width' | 'height'>): Pt | null {
  if (!(rect.width > 0) || !(rect.height > 0) || ![clientX, clientY].every(Number.isFinite)) return null
  const x = ((clientX - rect.left) / rect.width) * doc.width
  const y = ((clientY - rect.top) / rect.height) * doc.height
  return { x: Math.max(0, Math.min(doc.width, x)), y: Math.max(0, Math.min(doc.height, y)) }
}

// a shape worth keeping: a dot of pen still counts, a zero size box doesn't
export function validShape(s: Shape): boolean {
  if (s.tool === 'text') return !!s.text?.trim() && s.points.length >= 1
  if (s.points.length < 2) return false
  if (s.tool === 'pen') return true
  const a = s.points[0]
  const b = s.points[s.points.length - 1]
  return Math.hypot(b.x - a.x, b.y - a.y) >= 2
}

// the two short lines of an arrow's head at its end
export function arrowHead(from: Pt, to: Pt, width: number): [Pt, Pt] {
  const len = Math.max(12, width * 4)
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: to.x - len * Math.cos(ang - spread), y: to.y - len * Math.sin(ang - spread) },
    { x: to.x - len * Math.cos(ang + spread), y: to.y - len * Math.sin(ang + spread) }
  ]
}

export function rectOf(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

// ---------- drawing ----------

// the bits of CanvasRenderingContext2D the pad uses, so a test can record the calls
export interface Ctx {
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void
  strokeStyle: unknown
  fillStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  font: string
  textBaseline: string
}

export const FONT = '600 {size}px "Segoe UI Variable Text", "Segoe UI", Inter, sans-serif'
const contrast = (color: string): string => (/^#(f|e|d)/i.test(color) ? '#111111' : '#ffffff')

function drawShape(ctx: Ctx, s: Shape): void {
  ctx.save()
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const [a] = s.points
  const b = s.points[s.points.length - 1]
  switch (s.tool) {
    case 'pen': {
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      // a single click is a dot
      if (s.points.length === 1) ctx.lineTo(a.x + 0.01, a.y)
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break
    }
    case 'line':
    case 'arrow': {
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      if (s.tool === 'arrow') {
        const [l, r] = arrowHead(a, b, s.width)
        ctx.moveTo(l.x, l.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(r.x, r.y)
      }
      ctx.stroke()
      break
    }
    case 'box': {
      const r = rectOf(a, b)
      ctx.strokeRect(r.x, r.y, r.w, r.h)
      break
    }
    case 'ellipse': {
      const r = rectOf(a, b)
      ctx.beginPath()
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'text': {
      const text = (s.text ?? '').trim()
      if (!text) break
      ctx.font = FONT.replace('{size}', String(s.width))
      ctx.textBaseline = 'top'
      // an outline in the opposite tone so it reads on any picture
      ctx.strokeStyle = contrast(s.color)
      ctx.lineWidth = Math.max(2, s.width / 8)
      ctx.strokeText(text, a.x, a.y)
      ctx.fillText(text, a.x, a.y)
      break
    }
  }
  ctx.restore()
}

// the picture (or blank paper) and every shape, in order
export function drawSketch(ctx: Ctx, doc: SketchDoc, picture: unknown | null, extra: Shape | null = null): void {
  if (picture) ctx.drawImage(picture, 0, 0, doc.width, doc.height)
  else {
    ctx.fillStyle = doc.paper ?? PAPER
    ctx.fillRect(0, 0, doc.width, doc.height)
  }
  for (const s of doc.shapes) drawShape(ctx, s)
  if (extra) drawShape(ctx, extra)
}

// ---------- eraser ----------

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// how far a point is from a shape's ink, in picture pixels
export function distanceTo(s: Shape, p: Pt): number {
  const a = s.points[0]
  const b = s.points[s.points.length - 1]
  switch (s.tool) {
    case 'pen': {
      if (s.points.length === 1) return Math.hypot(p.x - a.x, p.y - a.y)
      let d = Infinity
      for (let i = 1; i < s.points.length; i++) d = Math.min(d, segDist(p, s.points[i - 1], s.points[i]))
      return d
    }
    case 'line':
      return segDist(p, a, b)
    case 'arrow': {
      const [l, r] = arrowHead(a, b, s.width)
      return Math.min(segDist(p, a, b), segDist(p, l, b), segDist(p, r, b))
    }
    case 'box': {
      const r = rectOf(a, b)
      const c = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]
      return Math.min(...c.map((q, i) => segDist(p, q, c[(i + 1) % 4])))
    }
    case 'ellipse': {
      const r = rectOf(a, b)
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      let d = Infinity
      let prev: Pt | null = null
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2
        const q = { x: cx + (r.w / 2) * Math.cos(t), y: cy + (r.h / 2) * Math.sin(t) }
        if (prev) d = Math.min(d, segDist(p, prev, q))
        prev = q
      }
      return d
    }
    case 'text': {
      const w = (s.text ?? '').length * s.width * 0.6
      const inside = p.x >= a.x && p.x <= a.x + w && p.y >= a.y && p.y <= a.y + s.width * 1.2
      return inside ? 0 : Infinity
    }
  }
}

// the shapes left after the eraser passed over these points
export function erase(shapes: Shape[], path: Pt[], radius: number): Shape[] {
  return shapes.filter((s) => !path.some((p) => distanceTo(s, p) <= radius + s.width / 2))
}

// ---------- history ----------

export interface History {
  past: Shape[][]
  future: Shape[][]
}

export const emptyHistory = (): History => ({ past: [], future: [] })

// a change: what was there goes on the undo stack, redo is forgotten
export function commit(h: History, before: Shape[]): History {
  return { past: [...h.past, before].slice(-100), future: [] }
}

export function undo(h: History, now: Shape[]): { history: History; shapes: Shape[] } | null {
  if (!h.past.length) return null
  return { history: { past: h.past.slice(0, -1), future: [now, ...h.future] }, shapes: h.past[h.past.length - 1] }
}

export function redo(h: History, now: Shape[]): { history: History; shapes: Shape[] } | null {
  if (!h.future.length) return null
  return { history: { past: [...h.past, now], future: h.future.slice(1) }, shapes: h.future[0] }
}

// ---------- export ----------

// a plain name for the png: what it was drawn on and when
export function sketchName(base: string | null, at = new Date()): string {
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}.${String(at.getMinutes()).padStart(2, '0')}`
  const clean = (base ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60)
  return clean ? `Sketch on ${clean} ${stamp}.png` : `Sketch ${stamp}.png`
}

// what the agent gets told about the shapes, so the marks mean something without looking
export function describeShapes(shapes: Shape[]): string {
  const counts = new Map<string, number>()
  for (const s of shapes) counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1)
  const parts = [...counts].map(([t, n]) => `${n} ${t === 'box' ? (n > 1 ? 'boxes' : 'box') : `${t}${n > 1 ? 's' : ''}`}`)
  const texts = shapes.filter((s) => s.tool === 'text' && s.text?.trim()).map((s) => `"${s.text!.trim()}"`)
  return [parts.join(', '), texts.length ? `text: ${texts.join(', ')}` : ''].filter(Boolean).join('; ')
}
