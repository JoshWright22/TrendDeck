import { describe, expect, it } from 'vitest'
import { cleanComments, formatAnswer, formatReview, parseReview, reviewTime, REVIEW_LANG } from './cards'

describe('review comments', () => {
  it('orders ends, clamps to the video and drops empty or broken ones', () => {
    const out = cleanComments(
      [
        { from: 12.5, to: 10, text: ' too slow ' },
        { from: -3, text: 'start' },
        { from: 50, to: 90, text: 'past the end' },
        { from: 1, to: 2, text: '   ' },
        { from: Number.NaN, text: 'nan' },
        { to: 3, text: 'no start' },
        null
      ],
      60
    )
    expect(out).toEqual([
      { from: 0, to: 0, text: 'start' },
      { from: 10, to: 12.5, text: 'too slow' },
      { from: 50, to: 60, text: 'past the end' }
    ])
  })

  it('keeps a box inside the frame and drops a bad frame id', () => {
    const [c] = cleanComments([{ from: 1, text: 'logo', frameId: '../x', box: { x: 1900, y: 10, width: 100, height: 0.4 }, frameWidth: 1920, frameHeight: 1080 }])
    expect(c.frameId).toBeUndefined()
    expect(c.box).toBeUndefined()
    const [d] = cleanComments([{ from: 1, text: 'logo', frameId: 'f-1', box: { x: 1900, y: 10.4, width: 100, height: 50 }, frameWidth: 1920, frameHeight: 1080 }])
    expect(d).toMatchObject({ frameId: 'f-1', box: { x: 1900, y: 10, width: 20, height: 50 }, frameWidth: 1920, frameHeight: 1080 })
  })

  it('formats ranges and single frames readably and round trips through the json part', () => {
    const text = formatReview(
      {
        cardId: 'card-1',
        projectId: 'p1',
        file: 'exports/cut "v2".mp4',
        comments: [
          { from: 41.2, to: 41.2, text: 'Logo too small', frameId: 'frame-a', box: { x: 10, y: 20, width: 300, height: 200 }, frameWidth: 1920, frameHeight: 1080 },
          { from: 12.5, to: 15, text: 'Cut is\nearly' }
        ]
      },
      'Desk setup'
    )
    expect(text).toContain('Review of exports/cut "v2".mp4 in Desk setup')
    expect(text).toContain('1. 00:12.500 to 00:15.000: Cut is early')
    expect(text).toContain('2. at 00:41.200: Logo too small (frame frame-a, box x 10, y 20, 300 by 200 of 1920 by 1080)')
    expect(text).toContain('review_frame_get')
    expect(text).toContain('```' + REVIEW_LANG)
    expect(parseReview(text)).toEqual({
      cardId: 'card-1',
      projectId: 'p1',
      file: 'exports/cut "v2".mp4',
      comments: [
        { from: 12.5, to: 15, text: 'Cut is\nearly' },
        { from: 41.2, to: 41.2, text: 'Logo too small', frameId: 'frame-a', box: { x: 10, y: 20, width: 300, height: 200 }, frameWidth: 1920, frameHeight: 1080 }
      ]
    })
  })

  it('refuses an empty review and reads nothing from plain text', () => {
    expect(() => formatReview({ cardId: 'c', projectId: 'p', file: 'a.mp4', comments: [] })).toThrow(/comment/)
    expect(parseReview('no review here')).toBeNull()
    expect(parseReview('```' + REVIEW_LANG + '\n{broken\n```')).toBeNull()
  })

  it('formats times with hours when needed', () => {
    expect(reviewTime(0)).toBe('00:00.000')
    expect(reviewTime(3723.4567)).toBe('1:02:03.457')
  })
})

describe('suggestion answers', () => {
  const card = { id: 'c1', title: 'Tighter intro', kind: 'edit' as const }
  it('says what was picked in plain words with the card id', () => {
    expect(formatAnswer(card, { choice: 'accept', text: '' })).toBe('Yes to your edit suggestion "Tighter intro" (card c1). Go ahead.')
    expect(formatAnswer(card, { choice: 'later', text: 'after the music' })).toContain('Not now for your edit suggestion')
    expect(formatAnswer(card, { choice: 'reply', text: 'cut 2 s less' })).toContain('cut 2 s less')
    expect(formatAnswer(card, { choice: 'apply', text: '' })).toContain('card_update')
    expect(formatAnswer(card, { choice: 'Use version B', text: '' })).toContain('I picked "Use version B"')
  })
})
