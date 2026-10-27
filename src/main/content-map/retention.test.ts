import { describe, expect, it } from 'vitest'
import type { RetentionPoint } from '@shared/content-map'
import type { SpokenWord } from '@shared/speech'
import { bestScriptLine, findDips, findSpikes, hookFromLines, lineAt, mapDips, markRecurring, pacingFromLines, pacingFromWords, parseCues, summarizeRetention, watchAt } from './retention'

// a typical curve: a fast intro drop, then a slow steady decline, with cliffs where asked
function curve(cliffs: { at: number; drop: number }[] = [], spike: number | null = null): RetentionPoint[] {
  const pts: RetentionPoint[] = []
  let watch = 1
  for (let i = 0; i <= 100; i++) {
    const ratio = i / 100
    if (i > 0) watch -= i <= 3 ? 0.08 : 0.003
    for (const c of cliffs) if (i === Math.round(c.at * 100)) watch -= c.drop
    if (spike !== null && i === Math.round(spike * 100)) watch += 0.04
    pts.push({ ratio, watch: Math.max(0, Math.round(watch * 1000) / 1000) })
  }
  return pts
}

describe('retention dips', () => {
  it('finds a cliff and turns it into seconds, ignoring the intro and the slow decline', () => {
    const dips = findDips(curve([{ at: 0.42, drop: 0.08 }]), 600)
    expect(dips).toHaveLength(1)
    expect(dips[0].from).toBeCloseTo(246, 0)
    expect(dips[0].to).toBeCloseTo(252, 0)
    expect(dips[0].drop).toBeGreaterThan(0.08)
    expect(dips[0].steepness).toBeGreaterThan(10)
  })

  it('finds no dip on a smooth curve and none in the last 4% where everyone leaves', () => {
    expect(findDips(curve(), 600)).toEqual([])
    expect(findDips(curve([{ at: 0.98, drop: 0.1 }]), 600)).toEqual([])
    expect(findDips(curve().slice(0, 5), 600)).toEqual([])
  })

  it('merges neighbouring steep steps into one dip and keeps the biggest five in time order', () => {
    const merged = findDips(curve([{ at: 0.3, drop: 0.04 }, { at: 0.31, drop: 0.04 }]), 100)
    expect(merged).toHaveLength(1)
    expect(merged[0].from).toBeCloseTo(29, 0)
    expect(merged[0].to).toBeCloseTo(31, 0)
    const many = findDips(curve([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((at, i) => ({ at, drop: 0.02 + i * 0.01 }))), 100)
    expect(many).toHaveLength(5)
    expect(many.map((d) => Math.round(d.from))).toEqual([29, 39, 49, 59, 69])
  })

  it('reads the share watching at any point and finds rewatch spikes', () => {
    const pts = curve([], 0.5)
    expect(watchAt(pts, 0)).toBe(1)
    expect(watchAt(pts, 0.005)).toBeCloseTo(0.96, 2)
    expect(findSpikes(pts, 200)[0].at).toBeCloseTo(100, 0)
  })
})

describe('mapping dips to lines', () => {
  const srt = `1
00:00:00,000 --> 00:00:04,000
So last week I tried something dumb.

2
00:00:04,000 --> 00:00:09,500
<i>I built a whole PC</i> for three hundred dollars.

3
00:04:05,000 --> 00:04:12,000
Now let me walk you through every part in the build.

4
00:04:05,000 --> 00:04:12,000
Now let me walk you through every part in the build.
`

  it('parses srt and vtt cues with times, tags stripped and rolled-up repeats merged', () => {
    const cues = parseCues(srt)
    expect(cues).toHaveLength(3)
    expect(cues[1]).toMatchObject({ text: 'I built a whole PC for three hundred dollars.', from: 4, to: 9.5, source: 'transcript' })
    const vtt = parseCues('WEBVTT\n\n00:01.000 --> 00:03.500\nHello there\n\nNOTE skipped\n\n01:02:03.250 --> 01:02:05.000 align:start\nLate line')
    expect(vtt.map((c) => [c.text, c.from])).toEqual([
      ['Hello there', 1],
      ['Late line', 3723.25]
    ])
    expect(hookFromLines(cues)).toBe('So last week I tried something dumb. I built a whole PC for three hundred dollars.')
  })

  it('puts each dip on the line being said, swapped for the script line it matches', () => {
    const cues = parseCues(srt)
    const script = ['So last week I tried something dumb.', 'Now let me walk you through every single part of the build.']
    const mapped = mapDips([{ from: 246, to: 252, drop: 0.08, steepness: 12 }, { from: 100, to: 102, drop: 0.03, steepness: 4 }], cues, script)
    expect(mapped[0]).toMatchObject({ from: 246, line: 'Now let me walk you through every single part of the build.', lineSource: 'script' })
    // nothing said near 1:40
    expect(mapped[1]).toMatchObject({ line: '', lineSource: '' })
    // no script: the caption itself
    expect(mapDips([{ from: 5, to: 6, drop: 0.05, steepness: 3 }], cues)[0]).toMatchObject({ line: 'I built a whole PC for three hundred dollars.', lineSource: 'transcript' })
  })

  it('takes a line starting inside the dip, or one that ended just before it', () => {
    const lines = [
      { text: 'a', from: 0, to: 2, source: 'transcript' as const },
      { text: 'b', from: 10, to: 12, source: 'transcript' as const }
    ]
    expect(lineAt(lines, 8, 11)?.text).toBe('b')
    expect(lineAt(lines, 4, 5)?.text).toBe('a')
    expect(lineAt(lines, 30, 31)).toBeNull()
    expect(bestScriptLine('totally different words', ['nothing alike here'])).toBe('')
  })

  it('marks a dip recurring when two other videos dropped at the same relative point', () => {
    const d = mapDips([{ from: 60, to: 63, drop: 0.05, steepness: 5 }], [])
    const others = [
      { duration: 200, dips: [{ from: 21, to: 22, drop: 0.04, steepness: 4 }] },
      { duration: 1000, dips: [{ from: 95, to: 99, drop: 0.04, steepness: 4 }] },
      { duration: 300, dips: [{ from: 200, to: 210, drop: 0.04, steepness: 4 }] }
    ]
    expect(markRecurring(d, 600, others)[0].recurring).toBe(true)
    expect(markRecurring(d, 600, others.slice(1))[0].recurring).toBe(false)
  })

  it('summarizes: share at 30 s only for videos of a minute or more', () => {
    const s = summarizeRetention(curve([{ at: 0.42, drop: 0.08 }]), 600, parseCues(srt), [])
    expect(s.at30).toBeCloseTo(0.75, 1)
    expect(s.dips).toHaveLength(1)
    expect(summarizeRetention(curve(), 45, [], []).at30).toBeNull()
    expect(summarizeRetention([], 600, [], [])).toEqual({ duration: 600, at30: null, dips: [], spikes: [] })
  })
})

describe('pacing', () => {
  it('measures words a minute and pauses from word times', () => {
    // 60 words over 30 s with a 1 s pause every 10 words
    const words: SpokenWord[] = []
    let t = 0
    for (let i = 0; i < 60; i++) {
      if (i && i % 10 === 0) t += 1
      words.push({ text: 'w', start: t, end: t + 0.35 })
      t += 0.4
    }
    const p = pacingFromWords(words, 'take')
    expect(p).not.toBeNull()
    expect(p?.wpm).toBeGreaterThan(100)
    expect(p?.wpm).toBeLessThan(130)
    expect(p?.longestPause).toBeCloseTo(1.1, 1)
    expect(p?.approximate).toBe(false)
    expect(pacingFromWords(words.slice(0, 5), 'take')).toBeNull()
  })

  it('estimates from caption cues and says so', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ text: 'one two three four five six seven eight', from: i * 4, to: i * 4 + 3, source: 'transcript' as const }))
    const p = pacingFromLines(lines)
    expect(p?.approximate).toBe(true)
    expect(p?.pausesPerMin).toBeGreaterThan(0)
  })
})
