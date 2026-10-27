export interface VideoReviewRange {
  startSeconds: number
  endSeconds: number
}

export interface VideoReviewRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface VideoReviewFrame {
  clipId: string
  revision?: string
  dataUrl: string
  timeSeconds: number
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  region?: VideoReviewRegion
}

export function clampReviewTime(value: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(value)) return 0
  return Math.min(duration, Math.max(0, value))
}

export function updateReviewRange(
  range: VideoReviewRange,
  edge: 'startSeconds' | 'endSeconds',
  value: number,
  duration: number
): VideoReviewRange {
  const startSeconds = clampReviewTime(range.startSeconds, duration)
  const endSeconds = Math.max(startSeconds, clampReviewTime(range.endSeconds, duration))
  if (!Number.isFinite(value)) return { startSeconds, endSeconds }
  const time = clampReviewTime(value, duration)
  return edge === 'startSeconds'
    ? { startSeconds: time, endSeconds: Math.max(time, endSeconds) }
    : { startSeconds: Math.min(startSeconds, time), endSeconds: time }
}

export function reviewLoopTarget(time: number, range: VideoReviewRange): number | null {
  if (!Number.isFinite(time) || !Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)
    || range.startSeconds < 0 || range.endSeconds <= range.startSeconds) return null
  return time < range.startSeconds || time >= range.endSeconds ? range.startSeconds : null
}

export function formatReviewTime(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const remainingSeconds = Math.floor(milliseconds / 1000) % 60
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}

export function reviewRegionFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number
): VideoReviewRegion | null {
  if (![start.x, start.y, end.x, end.y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null
  if (start.x === end.x || start.y === end.y) return null
  const left = Math.floor(Math.max(0, Math.min(width, start.x, end.x)))
  const top = Math.floor(Math.max(0, Math.min(height, start.y, end.y)))
  const right = Math.ceil(Math.max(0, Math.min(width, Math.max(start.x, end.x))))
  const bottom = Math.ceil(Math.max(0, Math.min(height, Math.max(start.y, end.y))))
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

export function formatVideoReviewFeedback(input: {
  clipId: string
  revision?: string
  name: string
  text: string
  range: VideoReviewRange
  duration: number
}): string {
  if (!input.clipId.trim()) throw new Error('A clip identifier is required.')
  if (!input.text.trim()) throw new Error('Write feedback before sending.')
  if (!Number.isFinite(input.duration) || input.duration <= 0) throw new Error('Wait for the video to load.')
  const { startSeconds, endSeconds } = input.range
  if (![startSeconds, endSeconds].every(Number.isFinite) || startSeconds < 0
    || endSeconds < startSeconds || endSeconds > input.duration) throw new Error('Select a valid video range.')
  return [
    'Video review feedback',
    `Clip: ${JSON.stringify(input.clipId)}`,
    `Name: ${JSON.stringify(input.name)}`,
    ...(input.revision !== undefined ? [`Revision: ${JSON.stringify(input.revision)}`] : []),
    `Range: ${formatReviewTime(startSeconds)} – ${formatReviewTime(endSeconds)}`,
    `Exact range (seconds): ${startSeconds} – ${endSeconds}`,
    '',
    input.text.trim()
  ].join('\n')
}
