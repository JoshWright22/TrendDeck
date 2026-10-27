import { describe, expect, it } from 'vitest'
import type { SnapshotLabel } from '@shared/content-map'
import { ageRatio, classify, failed, finished, nextDue, nextQuotaReset, NO_BACKOFF, plan, QUOTA_LIMIT, quotaDay, spend, tick, type Reading, type ScheduleState, type Tracked } from './schedule'

const H = 3600_000
const D = 24 * H
// noon UTC, 5 am in Los Angeles
const T0 = Date.UTC(2026, 9, 20, 12)

const fresh = (id = 'vid', publishedAt = T0): Tracked => ({ id, publishedAt, taken: [], missed: [] })
const reading = (id: string, views: number): Reading => ({ id, views, engagedViews: null, likes: 1, comments: 0, avgViewPercent: null, source: 'data-api' })

// a fake YouTube that counts calls and can fail on purpose
function fakeReader(views: (id: string, n: number) => number = () => 100) {
  const calls: { ids: string[]; labels: Record<string, SnapshotLabel> }[] = []
  let failWith: Error | null = null
  return {
    calls,
    fail(err: Error | null) {
      failWith = err
    },
    read: async (ids: string[], labels: Map<string, SnapshotLabel>): Promise<Reading[]> => {
      if (failWith) throw failWith
      calls.push({ ids, labels: Object.fromEntries(labels) })
      return ids.map((id) => reading(id, views(id, calls.length)))
    }
  }
}

describe('snapshot plan', () => {
  it('takes each label once it is due, nothing before', () => {
    expect(plan(fresh(), T0 + 30 * 60_000)).toEqual({ take: null, due: null, missed: [] })
    expect(plan(fresh(), T0 + H)).toEqual({ take: '1h', due: T0 + H, missed: [] })
  })

  it('catches up after the app was closed: the latest due label, earlier ones missed', () => {
    // opened 30 hours after publish: 1h and 6h can't be read anymore, 24h is 6 hours late
    expect(plan(fresh(), T0 + 30 * H)).toEqual({ take: '24h', due: T0 + D, missed: ['1h', '6h'] })
  })

  it("doesn't take a snapshot too far past its time", () => {
    // 3 days after a 48h label is more than its 24 hour tolerance
    expect(plan({ ...fresh(), taken: [], missed: ['1h', '6h', '24h'] }, T0 + 5 * D)).toEqual({ take: null, due: null, missed: ['48h'] })
    expect(finished(fresh(), T0 + 50 * D)).toBe(true)
    expect(finished(fresh(), T0 + 20 * D)).toBe(false)
  })

  it('knows when the next one is due', () => {
    expect(nextDue([fresh()], T0)).toBe(T0 + H)
    expect(nextDue([fresh('a'), fresh('b', T0 - 2 * H)], T0)).toBe(T0)
    expect(nextDue([{ ...fresh(), missed: ['1h', '6h', '24h', '48h', '7d', '28d'] }], T0)).toBeNull()
  })
})

describe('snapshot ticks on a fake clock', () => {
  it('runs a video through all six snapshots with the app open', async () => {
    const yt = fakeReader((_, n) => n * 100)
    let s: ScheduleState = { tracked: [fresh()], quota: null, backoff: NO_BACKOFF }
    const labels: string[] = []
    // a tick every 30 minutes for 29 days
    for (let t = T0; t <= T0 + 29 * D; t += 30 * 60_000) {
      const r = await tick(s, t, yt.read, () => 1)
      s = r.state
      labels.push(...r.taken.map((x) => x.label))
    }
    expect(labels).toEqual(['1h', '6h', '24h', '48h', '7d', '28d'])
    expect(s.tracked[0].missed).toEqual([])
    expect(s.tracked[0].taken.map((x) => x.views)).toEqual([100, 200, 300, 400, 500, 600])
    expect(yt.calls).toHaveLength(6)
  })

  it('catches up once on start and marks what it missed', async () => {
    const yt = fakeReader()
    const r = await tick({ tracked: [fresh()], quota: null, backoff: NO_BACKOFF }, T0 + 30 * H, yt.read, () => 1)
    expect(r.taken).toEqual([{ id: 'vid', label: '24h' }])
    expect(r.state.tracked[0].missed).toEqual(['1h', '6h'])
    expect(r.state.tracked[0].taken[0]).toMatchObject({ label: '24h', due: T0 + D, at: T0 + 30 * H })
    // ticking again right away reads nothing new
    const again = await tick(r.state, T0 + 30 * H + 60_000, yt.read, () => 1)
    expect(again.taken).toEqual([])
    expect(yt.calls).toHaveLength(1)
  })

  it('reads 120 due videos in batches of 50, one call each', async () => {
    const yt = fakeReader()
    const tracked = Array.from({ length: 120 }, (_, i) => fresh(`v${i}`))
    const r = await tick({ tracked, quota: null, backoff: NO_BACKOFF }, T0 + H, yt.read, (ids) => (ids.length ? 1 : 0))
    expect(yt.calls.map((c) => c.ids.length)).toEqual([50, 50, 20])
    expect(r.state.quota?.used).toBe(3)
  })

  it('stops at the daily quota and waits for midnight Pacific', async () => {
    const yt = fakeReader()
    const reset = nextQuotaReset(T0)
    // published 6.5 hours before the reset, its 6h snapshot comes due with the quota used up
    const pub = reset - 6.5 * H
    const first = pub + 6 * H
    const full = { day: quotaDay(first), used: QUOTA_LIMIT }
    const r = await tick({ tracked: [fresh('vid', pub)], quota: full, backoff: NO_BACKOFF }, first, yt.read, () => 1)
    expect(r.taken).toEqual([])
    expect(yt.calls).toHaveLength(0)
    expect(r.state.backoff.until).toBe(reset)
    // still waiting a few minutes later
    const later = await tick(r.state, first + 10 * 60_000, yt.read, () => 1)
    expect(yt.calls).toHaveLength(0)
    // after the reset the count starts over and the 6h snapshot is read, 31 minutes late
    const after = await tick(later.state, reset + 60_000, yt.read, () => 1)
    expect(after.taken).toEqual([{ id: 'vid', label: '6h' }])
    expect(after.state.tracked[0].missed).toEqual(['1h'])
    expect(after.state.quota).toEqual({ day: quotaDay(reset + 60_000), used: 1 })
    expect(after.state.backoff).toEqual(NO_BACKOFF)
  })

  it('backs off when YouTube says the quota is gone', async () => {
    const yt = fakeReader()
    yt.fail(new Error('www.googleapis.com said 403 quotaExceeded: The request cannot be completed'))
    const r = await tick({ tracked: [fresh()], quota: null, backoff: NO_BACKOFF }, T0 + H, yt.read, () => 1)
    expect(r.error).toMatch(/quotaExceeded/)
    expect(r.state.backoff.until).toBe(nextQuotaReset(T0 + H))
    // the snapshot wasn't marked taken or missed, it's tried again after the reset
    expect(r.state.tracked[0].taken).toEqual([])
    expect(r.state.tracked[0].missed).toEqual([])
  })

  it('backs off network errors 15, 30, 60 minutes, capped at 6 hours, and clears on success', async () => {
    const yt = fakeReader()
    yt.fail(new Error('www.googleapis.com timed out'))
    let s: ScheduleState = { tracked: [fresh()], quota: null, backoff: NO_BACKOFF }
    let now = T0 + H
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      s = (await tick(s, now, yt.read, () => 1)).state
      waits.push(((s.backoff.until as number) - now) / 60_000)
      now = s.backoff.until as number
    }
    expect(waits).toEqual([15, 30, 60])
    expect(failed({ until: null, failures: 10, reason: '' }, 0, 'network', '').until).toBe(6 * H)
    yt.fail(null)
    // by now the 1h snapshot is too late to count, the next tick clears the backoff
    const ok = await tick(s, now, yt.read, () => 1)
    expect(ok.taken).toEqual([])
    expect(ok.state.tracked[0].missed).toEqual(['1h'])
    expect(ok.state.backoff).toEqual(NO_BACKOFF)
    const six = await tick(ok.state, T0 + 6 * H, yt.read, () => 1)
    expect(six.taken).toEqual([{ id: 'vid', label: '6h' }])
  })

  it('a video missing from the answer (deleted or private) counts as missed', async () => {
    const r = await tick({ tracked: [fresh()], quota: null, backoff: NO_BACKOFF }, T0 + H, async () => [], () => 1)
    expect(r.state.tracked[0].missed).toEqual(['1h'])
  })
})

describe('quota and errors', () => {
  it('counts per Pacific day', () => {
    // in October Los Angeles is UTC-7: 07:30 UTC is just past midnight there, 06:30 is the day before
    expect(quotaDay(Date.UTC(2026, 9, 21, 7, 30))).toBe('2026-10-21')
    expect(quotaDay(Date.UTC(2026, 9, 21, 6, 30))).toBe('2026-10-20')
    const q = spend(null, T0, 10)
    expect(q).toEqual({ day: quotaDay(T0), used: 10 })
    expect(spend({ day: '2000-01-01', used: QUOTA_LIMIT }, T0, 10)).toEqual({ day: quotaDay(T0), used: 10 })
    expect(spend(q, T0, QUOTA_LIMIT)).toBeNull()
  })

  it('resets at midnight Pacific, also across the daylight saving change', () => {
    // Oct 20 2026 is PDT (UTC-7): midnight is 07:00 UTC
    expect(nextQuotaReset(T0)).toBe(Date.UTC(2026, 9, 21, 7))
    // Dec 1 2026 is PST (UTC-8): midnight is 08:00 UTC
    expect(nextQuotaReset(Date.UTC(2026, 11, 1, 12))).toBe(Date.UTC(2026, 11, 2, 8))
  })

  it('sorts errors into quota, auth and network', () => {
    expect(classify(new Error('said 429 rateLimitExceeded'))).toBe('quota')
    expect(classify(new Error('Your YouTube sign-in expired. Connect again'))).toBe('auth')
    expect(classify(new Error('said 401 Invalid Credentials'))).toBe('auth')
    expect(classify(new Error('ECONNRESET'))).toBe('network')
  })
})

describe('views at the same age', () => {
  it('compares with the median of earlier videos at that label', () => {
    const at = (id: string, pub: number, views: number): Tracked => ({ id, publishedAt: pub, missed: [], taken: [{ label: '48h', due: pub + 2 * D, at: pub + 2 * D, views, engagedViews: null, likes: null, comments: null, avgViewPercent: null, source: 'data-api' }] })
    const others = [at('a', T0 - 40 * D, 1000), at('b', T0 - 30 * D, 2000), at('c', T0 - 20 * D, 3000)]
    const mine = at('me', T0, 4000)
    expect(ageRatio(mine, [...others, mine], '48h')).toEqual({ ratio: 2, views: 4000, baseline: 2000 })
    expect(ageRatio(mine, others.slice(1), '48h').ratio).toBeNull()
  })
})
