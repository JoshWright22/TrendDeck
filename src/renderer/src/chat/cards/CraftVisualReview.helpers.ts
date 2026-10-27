import type { CraftEmbedCard, ReviewBox } from '@shared/cards'
import { sendReview } from './VideoCard'

export interface VisualPoint {
  x: number
  y: number
}

export interface VisualMark {
  tool: 'circle' | 'freehand'
  points: VisualPoint[]
}

export function visualPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): VisualPoint | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
  }
}

export function visualMarkPath(mark: VisualMark, width: number, height: number): string {
  const first = mark.points[0]
  const last = mark.points.at(-1)
  if (!first || !last) return ''
  if (mark.tool === 'circle') {
    const radiusX = Math.abs(last.x - first.x) * width / 2
    const radiusY = Math.abs(last.y - first.y) * height / 2
    const centerX = (first.x + last.x) * width / 2
    const centerY = (first.y + last.y) * height / 2
    return `M ${centerX - radiusX} ${centerY} a ${radiusX} ${radiusY} 0 1 0 ${radiusX * 2} 0 a ${radiusX} ${radiusY} 0 1 0 ${-radiusX * 2} 0`
  }
  return mark.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x * width} ${point.y * height}`).join(' ')
}

export function validVisualMark(mark: VisualMark): boolean {
  if (mark.points.length < 2) return false
  const first = mark.points[0]
  if (mark.tool === 'circle') {
    const last = mark.points.at(-1)!
    return Math.abs(first.x - last.x) > 0.002 && Math.abs(first.y - last.y) > 0.002
  }
  return mark.points.some((point) => Math.hypot(point.x - first.x, point.y - first.y) > 0.002)
}

export function visualReviewBox(marks: VisualMark[], width: number, height: number): ReviewBox | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  const points = marks.filter(validVisualMark).flatMap((mark) => mark.points)
  if (!points.length) return null
  const bounds = points.reduce((box, point) => ({
    left: Math.min(box.left, point.x), top: Math.min(box.top, point.y),
    right: Math.max(box.right, point.x), bottom: Math.max(box.bottom, point.y)
  }), { left: 1, top: 1, right: 0, bottom: 0 })
  const padding = Math.max(2, width / 400)
  const left = Math.max(0, Math.floor(bounds.left * width - padding))
  const top = Math.max(0, Math.floor(bounds.top * height - padding))
  const right = Math.min(width, Math.ceil(bounds.right * width + padding))
  const bottom = Math.min(height, Math.ceil(bounds.bottom * height + padding))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function loadVisualFrame(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(src)) {
      reject(new Error('No Craft screenshot is available. Return to the editor and capture a screenshot first.'))
      return
    }
    const image = new Image()
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? resolve(image)
      : reject(new Error('The Craft screenshot is empty. Capture it again from the editor.'))
    image.onerror = () => reject(new Error('The Craft screenshot could not be read. Capture it again from the editor.'))
    image.src = src
  })
}

export async function markedVisualFrame(src: string, marks: VisualMark[]): Promise<{ dataUrl: string; width: number; height: number; box: ReviewBox | null }> {
  const image = await loadVisualFrame(src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This screenshot cannot be marked up. Try opening the review again.')
  context.drawImage(image, 0, 0)
  context.lineJoin = 'round'
  context.lineCap = 'round'
  for (const mark of marks.filter(validVisualMark)) {
    const path = new Path2D(visualMarkPath(mark, canvas.width, canvas.height))
    context.lineWidth = Math.max(2, canvas.width / 400) * 2
    context.strokeStyle = '#111111'
    context.stroke(path)
    context.lineWidth /= 2
    context.strokeStyle = '#ffffff'
    context.stroke(path)
  }
  return {
    dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height,
    box: visualReviewBox(marks, canvas.width, canvas.height)
  }
}

export async function sendCraftVisualReview(
  card: CraftEmbedCard,
  projectName: string,
  text: string,
  frame: Awaited<ReturnType<typeof markedVisualFrame>>,
  sendToAgent: (text: string) => Promise<void>
): Promise<void> {
  if (!text.trim()) throw new Error('Describe what should change first.')
  const time = card.appId === 'filmcraft' && Number.isFinite(card.focus?.time) ? Math.max(0, card.focus!.time!) : 0
  const context = [
    'Craft visual feedback on a captured screenshot, not a live editor overlay.',
    `App: ${JSON.stringify({ id: card.appId, name: card.appName })}`,
    `Capture context: ${JSON.stringify({ brandId: card.brandId, cardId: card.id, projectId: card.projectId, file: card.file, cardRevision: card.updatedAt, turnId: card.turn?.turnId ?? null, focus: card.focus })}`,
    'Card revision is the card updatedAt value, not an editor document revision. The editor may have changed since capture.',
    ...(card.file === null ? ['No explicit file was recorded on this card; resolve the current Craft project file before editing.'] : []),
    'Marks are drawn into the saved PNG. The review box encloses all marks in screenshot pixels, not document coordinates.',
    'The review time is card focus context only, not a measured screenshot playhead; non-FilmCraft reviews use zero as a storage placeholder.'
  ].join('\n')
  await sendReview(card.brandId, card.id, card.projectId, card.file ?? '', projectName, [{
    from: time, to: time, text: text.trim(), frameDataUrl: frame.dataUrl,
    frameWidth: frame.width, frameHeight: frame.height, box: frame.box
  }], (review) => sendToAgent(`${context}\n\n${review}`))
}
