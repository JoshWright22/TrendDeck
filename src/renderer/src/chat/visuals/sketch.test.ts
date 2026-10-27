import { describe, expect, it } from 'vitest'
import {
  arrowHead,
  commit,
  describeShapes,
  drawSketch,
  emptyHistory,
  erase,
  fitPicture,
  redo,
  sketchName,
  strokeFor,
  toDoc,
  undo,
  validShape,
  type Ctx,
  type Shape,
  type SketchDoc
} from './sketch'

// a canvas context that writes down what it was asked to do
function recorder(): Ctx & { log: string[] } {
  const log: string[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      log.push(`${name}(${args.map((a) => (typeof a === 'number' ? Math.round(a * 10) / 10 : typeof a === 'string' ? a : 'img')).join(',')})`)
    }
  const ctx = {
    log,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    ellipse: rec('ellipse'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    drawImage: rec('drawImage'),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: '',
    lineJoin: '',
    font: '',
    textBaseline: ''
  }
  return ctx
}

const shape = (tool: Shape['tool'], points: [number, number][], extra: Partial<Shape> = {}): Shape => ({
  id: `${tool}-${points.length}`,
  tool,
  color: '#ef4444',
  width: 4,
  points: points.map(([x, y]) => ({ x, y })),
  ...extra
})

const doc = (shapes: Shape[] = []): SketchDoc => ({ width: 1280, height: 720, paper: '#f5f5f5', shapes })

describe('sketch export', () => {
  it('draws the blank paper and every shape in order', () => {
    const ctx = recorder()
    drawSketch(ctx, doc([shape('box', [[10, 10], [110, 60]]), shape('ellipse', [[200, 200], [300, 260]]), shape('text', [[50, 400]], { text: 'Title here', width: 40 })]), null)
    expect(ctx.log[0]).toBe('fillRect(0,0,1280,720)')
    expect(ctx.log).toContain('strokeRect(10,10,100,50)')
    expect(ctx.log).toContain('ellipse(250,230,50,30,0,0,6.3)')
    expect(ctx.log).toContain('fillText(Title here,50,400)')
    // the outline goes under the fill so text reads on any picture
    expect(ctx.log.indexOf('strokeText(Title here,50,400)')).toBeLessThan(ctx.log.indexOf('fillText(Title here,50,400)'))
    expect(ctx.font).toContain('40px')
  })

  it('draws a picture under the marks instead of paper', () => {
    const ctx = recorder()
    drawSketch(ctx, { ...doc([shape('arrow', [[0, 0], [100, 0]])]), paper: null }, {})
    expect(ctx.log[0]).toBe('drawImage(img,0,0,1280,720)')
    expect(ctx.log).not.toContain('fillRect(0,0,1280,720)')
    // the shaft and both sides of the head
    expect(ctx.log.filter((l) => l.startsWith('lineTo(100,0)')).length).toBe(2)
  })

  it('a click with the pen is a dot', () => {
    const ctx = recorder()
    drawSketch(ctx, doc([shape('pen', [[5, 5]])]), null)
    expect(ctx.log).toContain('moveTo(5,5)')
    expect(ctx.log).toContain('stroke()')
  })

  it('names the png after what it was drawn on', () => {
    const at = new Date(2026, 9, 27, 9, 5)
    expect(sketchName(null, at)).toBe('Sketch 2026-10-27 09.05.png')
    expect(sketchName('fox/photo.jpg', at)).toBe('Sketch on fox photo 2026-10-27 09.05.png')
  })

  it('describes the marks for the agent', () => {
    expect(describeShapes([shape('box', [[0, 0], [5, 5]]), shape('box', [[0, 0], [9, 9]]), shape('arrow', [[0, 0], [9, 9]]), shape('text', [[0, 0]], { text: 'here' })])).toBe('2 boxes, 1 arrow, 1 text; text: "here"')
  })
})

describe('sketch geometry', () => {
  it('maps the pointer to picture pixels', () => {
    expect(toDoc(150, 75, { left: 100, top: 50, width: 640, height: 360 }, { width: 1280, height: 720 })).toEqual({ x: 100, y: 50 })
    expect(toDoc(0, 0, { left: 100, top: 50, width: 640, height: 360 }, { width: 1280, height: 720 })).toEqual({ x: 0, y: 0 })
    expect(toDoc(1, 1, { left: 0, top: 0, width: 0, height: 10 }, { width: 10, height: 10 })).toBeNull()
  })

  it('fits big pictures and scales strokes', () => {
    expect(fitPicture(4800, 2400)).toEqual({ width: 2400, height: 1200 })
    expect(fitPicture(800, 600)).toEqual({ width: 800, height: 600 })
    expect(strokeFor('medium', { width: 1280, height: 720 })).toBe(6)
    expect(strokeFor('thin', { width: 200, height: 100 })).toBe(2)
  })

  it('arrow heads point back from the tip', () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
    expect(l.x).toBeLessThan(100)
    expect(r.x).toBeLessThan(100)
    expect(Math.sign(l.y)).toBe(-Math.sign(r.y))
  })

  it('drops shapes that are too small', () => {
    expect(validShape(shape('box', [[0, 0], [1, 1]]))).toBe(false)
    expect(validShape(shape('box', [[0, 0], [10, 10]]))).toBe(true)
    expect(validShape(shape('text', [[0, 0]], { text: '  ' }))).toBe(false)
    expect(validShape(shape('pen', [[0, 0], [0, 0]]))).toBe(true)
  })
})

describe('eraser and history', () => {
  it('erases only what the eraser touches', () => {
    const line = shape('line', [[0, 0], [100, 0]])
    const box = shape('box', [[200, 200], [300, 300]])
    const label = shape('text', [[400, 400]], { text: 'abc', width: 20 })
    expect(erase([line, box, label], [{ x: 50, y: 3 }], 2)).toEqual([box, label])
    // inside a box isn't on its line
    expect(erase([box], [{ x: 250, y: 250 }], 2)).toEqual([box])
    expect(erase([box], [{ x: 200, y: 250 }], 2)).toEqual([])
    expect(erase([label], [{ x: 405, y: 405 }], 1)).toEqual([])
  })

  it('undo and redo', () => {
    const a = shape('line', [[0, 0], [10, 0]])
    const b = shape('box', [[0, 0], [10, 10]])
    let h = commit(emptyHistory(), [])
    h = commit(h, [a])
    let now = [a, b]
    const u = undo(h, now)!
    expect(u.shapes).toEqual([a])
    now = u.shapes
    const r = redo(u.history, now)!
    expect(r.shapes).toEqual([a, b])
    expect(redo(r.history, r.shapes)).toBeNull()
    // a new change forgets redo
    expect(commit(u.history, now).future).toEqual([])
    expect(undo(emptyHistory(), [])).toBeNull()
  })
})
