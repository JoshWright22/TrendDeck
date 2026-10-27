import { describe, expect, it } from 'vitest'
import {
  clampReviewTime, formatReviewTime, formatVideoReviewFeedback, reviewLoopTarget,
  reviewRegionFromDrag, updateReviewRange
} from './VideoReview.helpers'

describe('video review time and range helpers', () => {
  it('clamps times without rounding precise playhead values', () => {
    expect(clampReviewTime(1.23456789, 10)).toBe(1.23456789)
    expect(clampReviewTime(-1, 10)).toBe(0)
    expect(clampReviewTime(20, 10)).toBe(10)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite time or duration %s', (value) => {
    expect(clampReviewTime(value, 10)).toBe(0)
    expect(clampReviewTime(5, value)).toBe(0)
  })

  it('rejects unavailable durations', () => {
    expect(clampReviewTime(5, 0)).toBe(0)
    expect(clampReviewTime(5, -1)).toBe(0)
  })

  it('moves the opposite edge when endpoints cross and permits point feedback', () => {
    const range = { startSeconds: 2, endSeconds: 5 }
    expect(updateReviewRange(range, 'startSeconds', 7.123456, 10)).toEqual({ startSeconds: 7.123456, endSeconds: 7.123456 })
    expect(updateReviewRange(range, 'endSeconds', 1, 10)).toEqual({ startSeconds: 1, endSeconds: 1 })
    expect(range).toEqual({ startSeconds: 2, endSeconds: 5 })
  })

  it('clamps edits and ignores temporarily empty numeric input', () => {
    const range = { startSeconds: 2, endSeconds: 5 }
    expect(updateReviewRange(range, 'startSeconds', -1, 10)).toEqual({ startSeconds: 0, endSeconds: 5 })
    expect(updateReviewRange(range, 'endSeconds', 100, 10)).toEqual({ startSeconds: 2, endSeconds: 10 })
    expect(updateReviewRange(range, 'endSeconds', NaN, 10)).toEqual(range)
    expect(updateReviewRange(range, 'endSeconds', 10, 3)).toEqual({ startSeconds: 2, endSeconds: 3 })
  })

  it('uses a half-open loop and restarts before start or at/after end', () => {
    const range = { startSeconds: 2.125, endSeconds: 5.25 }
    expect(reviewLoopTarget(2, range)).toBe(2.125)
    expect(reviewLoopTarget(2.125, range)).toBeNull()
    expect(reviewLoopTarget(5.24999, range)).toBeNull()
    expect(reviewLoopTarget(5.25, range)).toBe(2.125)
    expect(reviewLoopTarget(10, range)).toBe(2.125)
  })

  it('does not loop degenerate or invalid ranges', () => {
    expect(reviewLoopTarget(5, { startSeconds: 2, endSeconds: 2 })).toBeNull()
    expect(reviewLoopTarget(5, { startSeconds: 3, endSeconds: 2 })).toBeNull()
    expect(reviewLoopTarget(5, { startSeconds: -1, endSeconds: 2 })).toBeNull()
    expect(reviewLoopTarget(NaN, { startSeconds: 0, endSeconds: 2 })).toBeNull()
    expect(reviewLoopTarget(5, { startSeconds: 0, endSeconds: Infinity })).toBeNull()
  })

  it('formats milliseconds with correct minute/hour carry', () => {
    expect(formatReviewTime(0)).toBe('00:00.000')
    expect(formatReviewTime(59.9996)).toBe('01:00.000')
    expect(formatReviewTime(3600.125)).toBe('1:00:00.125')
    expect(formatReviewTime(-1)).toBe('00:00.000')
    expect(formatReviewTime(NaN)).toBe('00:00.000')
  })
})

describe('video review feedback text', () => {
  const input = {
    clipId: 'clip-42', revision: 'revision-7', name: 'local clip.mp4', text: '  Tighten the pause.  ',
    range: { startSeconds: 1.23456789, endSeconds: 3.98765432 }, duration: 10
  }

  it('includes clip/revision, readable timestamps and unrounded seconds', () => {
    expect(formatVideoReviewFeedback(input)).toBe([
      'Video review feedback', 'Clip: "clip-42"', 'Name: "local clip.mp4"', 'Revision: "revision-7"',
      'Range: 00:01.235 – 00:03.988', 'Exact range (seconds): 1.23456789 – 3.98765432', '', 'Tighten the pause.'
    ].join('\n'))
  })

  it('omits absent revision and supports a precise point annotation', () => {
    const feedback = formatVideoReviewFeedback({ ...input, revision: undefined, range: { startSeconds: 2, endSeconds: 2 } })
    expect(feedback).not.toContain('Revision:')
    expect(feedback).toContain('Exact range (seconds): 2 – 2')
  })

  it('quotes metadata so newlines cannot masquerade as range fields', () => {
    expect(formatVideoReviewFeedback({ ...input, clipId: 'clip\nRange: fake' })).toContain('Clip: "clip\\nRange: fake"\n')
  })

  it('rejects missing identity, blank feedback, unloaded video and invalid ranges', () => {
    expect(() => formatVideoReviewFeedback({ ...input, clipId: ' ' })).toThrow('identifier')
    expect(() => formatVideoReviewFeedback({ ...input, text: ' \n ' })).toThrow('feedback')
    expect(() => formatVideoReviewFeedback({ ...input, duration: Infinity })).toThrow('load')
    for (const range of [
      { startSeconds: -1, endSeconds: 2 }, { startSeconds: 4, endSeconds: 3 },
      { startSeconds: 1, endSeconds: 11 }, { startSeconds: NaN, endSeconds: 2 },
      { startSeconds: 1, endSeconds: Infinity }
    ]) expect(() => formatVideoReviewFeedback({ ...input, range })).toThrow('valid video range')
  })
})

describe('video review frame regions', () => {
  it('supports reverse drag and encloses fractional source pixels', () => {
    expect(reviewRegionFromDrag({ x: 100.2, y: 80.4 }, { x: 20.8, y: 10.2 }, 200, 100))
      .toEqual({ x: 20, y: 10, width: 81, height: 71 })
  })

  it('clamps a drag beyond the source frame', () => {
    expect(reviewRegionFromDrag({ x: -20, y: -10 }, { x: 500, y: 250 }, 200, 100))
      .toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('rejects clicks, zero-area drags and invalid dimensions', () => {
    expect(reviewRegionFromDrag({ x: 1.2, y: 1.2 }, { x: 1.2, y: 1.2 }, 200, 100)).toBeNull()
    expect(reviewRegionFromDrag({ x: 1, y: 1 }, { x: 1, y: 20 }, 200, 100)).toBeNull()
    expect(reviewRegionFromDrag({ x: 220, y: 1 }, { x: 250, y: 20 }, 200, 100)).toBeNull()
    expect(reviewRegionFromDrag({ x: 1, y: 1 }, { x: 20, y: 20 }, 0, 100)).toBeNull()
    expect(reviewRegionFromDrag({ x: NaN, y: 1 }, { x: 20, y: 20 }, 200, 100)).toBeNull()
  })
})
