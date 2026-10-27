import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseReview, type CraftEmbedCard } from '@shared/cards'
import CraftVisualReview from './CraftVisualReview'
import type { CardActions } from './useCards'
import { loadVisualFrame, markedVisualFrame, sendCraftVisualReview, validVisualMark, visualMarkPath, visualPoint, visualReviewBox, type VisualMark } from './CraftVisualReview.helpers'

const circle: VisualMark = { tool: 'circle', points: [{ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 }] }
const freehand: VisualMark = { tool: 'freehand', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] }
const card: CraftEmbedCard = {
  id: 'card-1', brandId: 'brand-1', threadId: 'thread-1', messageId: null,
  at: 100, updatedAt: 200, type: 'craft', appId: 'photocraft', appName: 'PhotoCraft',
  projectId: 'project-1', file: 'thumbnail.pcproj', focus: { sequence: null, time: null, layer: 'Title' },
  note: '', turn: { turnId: 'turn-1', edits: 2, state: 'review', checkpoint: null, note: '' }, alternatives: null, auto: true
}
const frame = { dataUrl: 'data:image/png;base64,bWFya2Vk', width: 1000, height: 500, box: { x: 198, y: 48, width: 604, height: 304 } }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Craft screenshot coordinates', () => {
  it('normalizes displayed image coordinates independently of source resolution', () => {
    expect(visualPoint(260, 145, { left: 10, top: 20, width: 500, height: 250 })).toEqual({ x: 0.5, y: 0.5 })
    expect(visualPoint(-100, 900, { left: 10, top: 20, width: 500, height: 250 })).toEqual({ x: 0, y: 1 })
    expect(visualPoint(1, 1, { left: 0, top: 0, width: 0, height: 1 })).toBeNull()
    expect(visualPoint(NaN, 1, { left: 0, top: 0, width: 1, height: 1 })).toBeNull()
  })

  it('maps reverse-drag circles and multiple strokes to a padded screenshot pixel box', () => {
    expect(visualReviewBox([circle], 1000, 500)).toEqual({ x: 197, y: 47, width: 606, height: 306 })
    expect(visualReviewBox([circle, freehand], 1000, 500)).toEqual({ x: 0, y: 0, width: 1000, height: 500 })
    expect(visualReviewBox([], 1000, 500)).toBeNull()
    expect(visualReviewBox([circle], 0, 500)).toBeNull()
  })

  it('uses the same pixel path for preview and saved markup', () => {
    expect(visualMarkPath(freehand, 1000, 500)).toBe('M 0 0 L 500 250 L 1000 500')
    expect(visualMarkPath(circle, 1000, 500)).toContain('a 300.00000000000006 150 0 1 0')
    expect(visualMarkPath({ tool: 'circle', points: [] }, 1000, 500)).toBe('')
  })

  it('discards clicks and degenerate circles without discarding straight freehand strokes', () => {
    expect(validVisualMark({ tool: 'circle', points: [{ x: 0.5, y: 0.5 }] })).toBe(false)
    expect(validVisualMark({ tool: 'circle', points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }] })).toBe(false)
    expect(validVisualMark({ tool: 'freehand', points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }] })).toBe(true)
  })
})

describe('Craft review delivery', () => {
  it.each(['photocraft', 'soundcraft', 'filmcraft', 'designcraft'])('saves the marked PNG through safe frame IPC before sending %s feedback', async (appId) => {
    const saveFrame = vi.fn().mockResolvedValue('frame-1')
    const send = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { trenddeckCards: { saveFrame } })
    await sendCraftVisualReview({ ...card, appId }, 'My project', ' Change this. ', frame, send)
    expect(saveFrame).toHaveBeenCalledWith(card.brandId, card.id, {
      dataUrl: frame.dataUrl, timeSeconds: 0, width: 1000, height: 500, box: frame.box
    })
    expect(saveFrame.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    const message = send.mock.calls[0][0] as string
    expect(message).toContain('"cardRevision":200')
    expect(message).toContain('"turnId":"turn-1"')
    expect(message).toContain('"layer":"Title"')
    expect(message).toContain('not an editor document revision')
    expect(message).not.toContain(frame.dataUrl)
    expect(parseReview(message)).toEqual({ cardId: card.id, projectId: card.projectId, file: card.file, comments: [{
      from: 0, to: 0, text: 'Change this.', frameId: 'frame-1', box: frame.box, frameWidth: 1000, frameHeight: 500
    }] })
  })

  it('preserves FilmCraft focus as context without claiming it is the screenshot playhead', async () => {
    const saveFrame = vi.fn().mockResolvedValue('frame-1')
    const send = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { trenddeckCards: { saveFrame } })
    await sendCraftVisualReview({ ...card, appId: 'filmcraft', focus: { sequence: 12, time: 4.25, layer: null } }, '', 'Change this', frame, send)
    expect(saveFrame.mock.calls[0][2].timeSeconds).toBe(4.25)
    expect(send.mock.calls[0][0]).toContain('not a measured screenshot playhead')
  })

  it('retains an unknown file as unknown rather than fabricating a path', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { trenddeckCards: { saveFrame: vi.fn().mockResolvedValue('frame-1') } })
    await sendCraftVisualReview({ ...card, file: null, turn: null }, '', 'Change this', { ...frame, box: null }, send)
    expect(send.mock.calls[0][0]).toContain('"file":null')
    expect(send.mock.calls[0][0]).toContain('resolve the current Craft project file before editing')
    expect(parseReview(send.mock.calls[0][0])?.file).toBe('')
  })

  it('does not send when frame storage fails and propagates agent failures', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Agent unavailable'))
    const saveFrame = vi.fn().mockRejectedValue(new Error('Frame rejected'))
    vi.stubGlobal('window', { trenddeckCards: { saveFrame } })
    await expect(sendCraftVisualReview(card, '', 'Change this', frame, send)).rejects.toThrow('Frame rejected')
    expect(send).not.toHaveBeenCalled()
    saveFrame.mockResolvedValue('frame-1')
    await expect(sendCraftVisualReview(card, '', 'Change this', frame, send)).rejects.toThrow('Agent unavailable')
  })

  it('does not store or send blank feedback', async () => {
    const saveFrame = vi.fn()
    const send = vi.fn()
    vi.stubGlobal('window', { trenddeckCards: { saveFrame } })
    await expect(sendCraftVisualReview(card, '', '  ', frame, send)).rejects.toThrow('Describe')
    expect(saveFrame).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Craft screenshot rasterization', () => {
  function mockImage(width = 1000, height = 500, broken = false): void {
    vi.stubGlobal('Image', class {
      naturalWidth = width
      naturalHeight = height
      onload: () => void = () => {}
      onerror: () => void = () => {}
      set src(_value: string) { queueMicrotask(() => broken ? this.onerror() : this.onload()) }
    })
  }

  it('rejects missing screenshots, remote URLs, unreadable images and empty images clearly', async () => {
    await expect(loadVisualFrame('')).rejects.toThrow('No Craft screenshot')
    await expect(loadVisualFrame('https://example.invalid/frame.png')).rejects.toThrow('No Craft screenshot')
    mockImage(0, 0)
    await expect(loadVisualFrame(frame.dataUrl)).rejects.toThrow('empty')
    mockImage(1000, 500, true)
    await expect(loadVisualFrame(frame.dataUrl)).rejects.toThrow('could not be read')
  })

  it('draws the original into a separate PNG with both circle and freehand paths', async () => {
    mockImage()
    const paths: string[] = []
    vi.stubGlobal('Path2D', class { constructor(path: string) { paths.push(path) } })
    const context = { drawImage: vi.fn(), stroke: vi.fn(), lineWidth: 0, strokeStyle: '', lineJoin: '', lineCap: '' }
    const canvas = { width: 0, height: 0, getContext: vi.fn().mockReturnValue(context), toDataURL: vi.fn().mockReturnValue(frame.dataUrl) }
    const createCanvas = vi.fn().mockReturnValue(canvas)
    vi.stubGlobal('document', { createElement: createCanvas })
    const original = 'data:image/png;base64,b3JpZ2luYWw='
    const marks = structuredClone([circle, freehand])
    expect(await markedVisualFrame(original, marks)).toEqual({ ...frame, box: { x: 0, y: 0, width: 1000, height: 500 } })
    expect(createCanvas).toHaveBeenCalledWith('canvas')
    expect(context.drawImage).toHaveBeenCalledOnce()
    expect(context.stroke).toHaveBeenCalledTimes(4)
    expect(paths).toEqual(marks.map((mark) => visualMarkPath(mark, 1000, 500)))
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png')
    expect(marks).toEqual([circle, freehand])
  })

  it('supports unmarked screenshots and reports unavailable canvas without sending', async () => {
    mockImage()
    const stroke = vi.fn()
    const canvas = { width: 0, height: 0, getContext: vi.fn().mockReturnValue({ drawImage: vi.fn(), stroke }), toDataURL: vi.fn().mockReturnValue(frame.dataUrl) }
    vi.stubGlobal('document', { createElement: () => canvas })
    expect((await markedVisualFrame(frame.dataUrl, [])).box).toBeNull()
    expect(stroke).not.toHaveBeenCalled()
    canvas.getContext.mockReturnValue(null)
    await expect(markedVisualFrame(frame.dataUrl, [circle])).rejects.toThrow('cannot be marked up')
  })
})

describe('Craft visual review UI', () => {
  it('renders explicit screenshot-only instructions, drawing controls and cancel without side effects', () => {
    const sendToAgent = vi.fn()
    const saveFrame = vi.fn()
    const onClose = vi.fn()
    const still = vi.fn()
    vi.stubGlobal('window', { trenddeckCards: { saveFrame }, trenddeckEmbed: { still } })
    const actions = { brand: { id: card.brandId, projects: [] }, project: undefined, hasAgent: false, sendToAgent } as unknown as CardActions
    const markup = renderToStaticMarkup(createElement(CraftVisualReview, { card, a: actions, initialFrame: frame.dataUrl, onClose }))
    expect(markup).toContain('Circle / ellipse')
    expect(markup).toContain('Freehand')
    expect(markup).toContain('Undo mark')
    expect(markup).toContain('Cancel')
    expect(markup).toContain('does not draw on or modify your editor project')
    expect(markup).toContain('Set up an agent')
    expect(markup).not.toContain('Capture again')
    expect(markup).toContain('disabled=""')
    expect(saveFrame).not.toHaveBeenCalled()
    expect(sendToAgent).not.toHaveBeenCalled()
    expect(still).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
