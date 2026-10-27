import { describe, expect, it } from 'vitest'
import type { MapVideo, Pillar } from '@shared/content-map'
import { baselines, hookStyle, matchProject, median, pillarFor, rate, rows, similar, titleStyle, topKeywords, whatWorked } from './baseline'

const DAY = 24 * 3600_000
const NOW = Date.UTC(2026, 9, 27)

function video(id: string, daysAgo: number, views: number | null, over: Partial<MapVideo> = {}): MapVideo {
  return {
    id,
    platform: 'youtube',
    title: `Video ${id}`,
    url: '',
    publishedAt: NOW - daysAgo * DAY,
    duration: 600,
    format: 'long',
    thumbnailText: '',
    tags: [],
    description: '',
    hook: '',
    hookSource: '',
    pacing: null,
    metrics: views === null ? null : { views, engagedViews: null, avgViewDuration: null, avgViewPercent: null, likes: null, comments: null, shares: null, subsGained: null, impressions: null, ctr: null, at: NOW, sources: ['data-api'] },
    retention: [],
    retentionAt: null,
    projectId: null,
    projectPinned: false,
    ...over
  }
}

describe('median', () => {
  it('handles odd, even, empty and non-finite values', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
    expect(median([NaN, 5])).toBe(5)
  })
})

describe('rate against the channel baseline', () => {
  it('compares each video with the median of up to 10 earlier settled videos of the same format', () => {
    // 12 long videos, one every 10 days, 1000 views each, then a big one and a weak one
    const vids = Array.from({ length: 12 }, (_, i) => video(`v${i}`, 200 - i * 10, 1000))
    vids.push(video('hit', 30, 3200), video('miss', 20, 400))
    const r = rate(vids, NOW)
    expect(r.get('hit')).toMatchObject({ baseline: 1000, flag: 'top' })
    expect(r.get('hit')?.ratio).toBeCloseTo(3.2)
    expect(r.get('miss')).toMatchObject({ flag: 'bottom' })
    expect(r.get('miss')?.ratio).toBeCloseTo(0.4)
    expect(r.get('v11')?.flag).toBe('normal')
  })

  it("doesn't let a video's own later peers or Shorts into its baseline", () => {
    const vids = [video('a', 100, 100), video('b', 90, 100), video('c', 80, 100), video('d', 70, 10_000), video('s1', 60, 50_000, { format: 'short' })]
    const r = rate(vids, NOW)
    // d's baseline is a, b, c only
    expect(r.get('d')?.baseline).toBe(100)
    // the short has no other short to compare with, so no ratio rather than one against itself
    expect(r.get('s1')).toMatchObject({ ratio: null, baseline: null, flag: 'none' })
  })

  it('flags a video under a week old as early and keeps it out of the baseline', () => {
    const vids = [video('a', 60, 1000), video('b', 50, 1000), video('c', 40, 1000), video('new', 2, 150)]
    const r = rate(vids, NOW)
    expect(r.get('new')).toMatchObject({ flag: 'early', baseline: 1000 })
    expect(baselines(vids, NOW)[0]).toMatchObject({ median: 1000, count: 3, format: 'long' })
  })

  it('uses engaged views for Shorts when the platform has them', () => {
    const s = (id: string, d: number, views: number, engaged: number): MapVideo => {
      const v = video(id, d, views, { format: 'short' })
      ;(v.metrics as NonNullable<MapVideo['metrics']>).engagedViews = engaged
      return v
    }
    const vids = [s('a', 60, 10_000, 1000), s('b', 50, 10_000, 1000), s('c', 40, 10_000, 1000), s('d', 30, 10_000, 2000)]
    expect(rate(vids, NOW).get('d')?.ratio).toBeCloseTo(2)
    expect(baselines(vids, NOW)[0].metric).toBe('engaged views')
  })

  it('gives videos without numbers and local projects no ratio', () => {
    const r = rate([video('x', 30, null), video('local:p', 0, null, { platform: 'local', publishedAt: null })], NOW)
    expect(r.get('x')).toMatchObject({ ratio: null, flag: 'none' })
    expect(r.get('local:p')).toMatchObject({ ratio: null, flag: 'none' })
  })
})

describe('styles, pillars and grouping', () => {
  it('labels hooks and titles in plain words', () => {
    expect(hookStyle('Why does nobody talk about this? Here is the thing.')).toBe('question')
    expect(hookStyle('So last week I tried to build a PC for 300 dollars.')).toBe('story')
    expect(hookStyle('Here\'s how to fix your audio in five minutes.')).toBe('how-to')
    expect(hookStyle('You are editing your shorts wrong.')).toBe('talks to you')
    expect(hookStyle('')).toBe('unknown')
    expect(titleStyle('Why I quit my job?')).toBe('question')
    expect(titleStyle('How to light a room')).toBe('how-to')
    expect(titleStyle('7 mistakes new editors make')).toBe('number')
    expect(titleStyle('I built a desk')).toBe('first person')
    expect(titleStyle('Desk setup: the final version')).toBe('two-part')
  })

  const pillars: Pillar[] = [
    { id: 'p1', label: 'Budget builds', keywords: ['budget', 'cheap build'], why: '', createdAt: 0 },
    { id: 'p2', label: 'Editing', keywords: ['editing', 'premiere'], why: '', createdAt: 0 }
  ]

  it('puts a video in the pillar its title hits most, multi word keywords need every word', () => {
    expect(pillarFor(video('a', 10, 1, { title: 'The budget gaming PC' }), pillars)?.label).toBe('Budget builds')
    expect(pillarFor(video('b', 10, 1, { title: 'A cheap desk', tags: ['build'] }), pillars)?.label).toBe('Budget builds')
    expect(pillarFor(video('c', 10, 1, { title: 'Faster cuts', tags: ['premiere'] }), pillars)?.label).toBe('Editing')
    expect(pillarFor(video('d', 10, 1, { title: 'Cooking pasta' }), pillars)).toBeNull()
  })

  it('says which groups beat the baseline, leaving out first-week videos', () => {
    const vids = [
      video('a', 100, 1000, { title: 'Budget PC one' }),
      video('b', 90, 1000, { title: 'Budget PC two' }),
      video('c', 80, 1000, { title: 'Editing tips' }),
      video('d', 70, 3000, { title: 'Budget PC three' }),
      video('e', 60, 500, { title: 'Editing in premiere' }),
      video('f', 1, 99_999, { title: 'Budget PC brand new' })
    ]
    const w = whatWorked(rows(vids, pillars, NOW))
    const budget = w.pillar.find((g) => g.key === 'Budget builds')
    expect(budget?.count).toBe(4)
    expect(budget?.best[0].id).toBe('d')
    expect(budget?.best.some((b) => b.id === 'f')).toBe(false)
    expect(w.pillar[0].key).toBe('Budget builds')
    expect(whatWorked(rows(vids, pillars, NOW), { pillar: 'editing' }).pillar.map((g) => g.key)).toEqual(['Editing'])
  })

  it('finds recurring keywords and similar videos', () => {
    const vids = [
      video('a', 10, 1, { title: 'Budget gaming PC build', tags: ['pc build'] }),
      video('b', 20, 1, { title: 'Budget streaming PC' }),
      video('c', 30, 1, { title: 'Sourdough bread at home' })
    ]
    // a word counts once per video, so build (one video) isn't recurring
    expect(topKeywords(vids)).toEqual([{ word: 'budget', count: 2 }])
    const hits = similar(vids, 'a cheap budget PC for gaming')
    expect(hits[0].video.id).toBe('a')
    expect(hits.some((h) => h.video.id === 'c')).toBe(false)
    expect(similar(vids, 'the and of')).toEqual([])
  })

  it('matches a project to its post by most of the project name', () => {
    const projects = [
      { id: 'p1', name: 'Budget PC build' },
      { id: 'p2', name: 'Sourdough' }
    ]
    expect(matchProject('I made a budget PC build for $300', projects)).toBe('p1')
    expect(matchProject('Desk tour', projects)).toBeNull()
  })
})
