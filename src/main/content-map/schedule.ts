import { SNAPSHOT_LABELS, type MetricSource, type SnapshotLabel, type VideoSnapshot } from '@shared/content-map'

// when to read a new video's numbers: +1h, +6h, +24h, +48h, +7d and +28d after it went up.
// the app isn't always open, so a tick takes the latest snapshot that's due and still close
// enough to its time, and marks the earlier ones it can't go back for as missed. YouTube's daily
// quota resets at midnight Pacific; running out waits for that, network errors back off.
// pure apart from the reader it's given, tested on a fake clock

const H = 3600_000
const D = 24 * H

export const OFFSETS: Record<SnapshotLabel, number> = { '1h': H, '6h': 6 * H, '24h': D, '48h': 2 * D, '7d': 7 * D, '28d': 28 * D }

// how late a snapshot may be taken and still count for its label: half its age, at least an hour
export const tolerance = (label: SnapshotLabel): number => Math.max(H, OFFSETS[label] / 2)

export interface Tracked {
  id: string
  publishedAt: number
  taken: VideoSnapshot[]
  missed: SnapshotLabel[]
}

export interface Plan {
  take: SnapshotLabel | null
  due: number | null
  missed: SnapshotLabel[]
}

export function plan(t: Pick<Tracked, 'publishedAt' | 'taken' | 'missed'>, now: number): Plan {
  const done = new Set<SnapshotLabel>([...t.taken.map((s) => s.label), ...t.missed])
  const due = SNAPSHOT_LABELS.filter((l) => !done.has(l) && t.publishedAt + OFFSETS[l] <= now)
  if (!due.length) return { take: null, due: null, missed: [] }
  const last = due[due.length - 1]
  const lateBy = now - (t.publishedAt + OFFSETS[last])
  if (lateBy > tolerance(last)) return { take: null, due: null, missed: due }
  return { take: last, due: t.publishedAt + OFFSETS[last], missed: due.slice(0, -1) }
}

// the next time anything becomes due, null when every video is done
export function nextDue(list: Pick<Tracked, 'publishedAt' | 'taken' | 'missed'>[], now: number): number | null {
  let next: number | null = null
  for (const t of list) {
    const done = new Set<SnapshotLabel>([...t.taken.map((s) => s.label), ...t.missed])
    for (const l of SNAPSHOT_LABELS) {
      if (done.has(l)) continue
      const at = Math.max(now, t.publishedAt + OFFSETS[l])
      if (next === null || at < next) next = at
      break
    }
  }
  return next
}

// tracking stops once the 28 day one is in or can't be taken anymore
export function finished(t: Pick<Tracked, 'publishedAt' | 'taken' | 'missed'>, now: number): boolean {
  const done = new Set<SnapshotLabel>([...t.taken.map((s) => s.label), ...t.missed])
  return done.has('28d') || now > t.publishedAt + OFFSETS['28d'] + tolerance('28d')
}

// ---------- quota ----------

export interface Quota {
  // the Pacific day the count is for, YYYY-MM-DD
  day: string
  used: number
}

// YouTube Data API: 10,000 units a day per project. TrendDeck keeps well under it so the
// creator's other tools keep working
export const QUOTA_LIMIT = 6000

const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

function pacificParts(now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of pacific.formatToParts(new Date(now))) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return out
}

export function quotaDay(now: number): string {
  const p = pacificParts(now)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function nextQuotaReset(now: number): number {
  const p = pacificParts(now)
  const into = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (now % 1000)
  return now - into + D
}

export function quotaUsed(q: Quota | null, now: number): number {
  return q && q.day === quotaDay(now) ? q.used : 0
}

// spends units if there's room under the limit, null when there isn't
export function spend(q: Quota | null, now: number, units: number, limit = QUOTA_LIMIT): Quota | null {
  const used = quotaUsed(q, now)
  if (used + units > limit) return null
  return { day: quotaDay(now), used: used + units }
}

// ---------- backoff ----------

export interface Backoff {
  until: number | null
  failures: number
  reason: string
}

export const NO_BACKOFF: Backoff = { until: null, failures: 0, reason: '' }

export type FailureKind = 'quota' | 'network' | 'auth'

export function classify(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err)
  if (/quota|rateLimit|userRateLimit|dailyLimit|\b429\b/i.test(msg)) return 'quota'
  if (/\b401\b|invalid_grant|unauthori[sz]ed|not connected|sign-in expired|insufficientPermissions/i.test(msg)) return 'auth'
  return 'network'
}

export function failed(b: Backoff, now: number, kind: FailureKind, reason: string): Backoff {
  const failures = b.failures + 1
  if (kind === 'quota') return { until: nextQuotaReset(now), failures, reason }
  // a lost login waits for the creator to connect again, checked again in a day
  if (kind === 'auth') return { until: now + D, failures, reason }
  return { until: now + Math.min(6 * H, 15 * 60_000 * 2 ** (failures - 1)), failures, reason }
}

export const waiting = (b: Backoff, now: number): boolean => b.until !== null && b.until > now

// ---------- one tick ----------

export interface Reading {
  id: string
  views: number | null
  engagedViews: number | null
  likes: number | null
  comments: number | null
  avgViewPercent: number | null
  source: MetricSource
}

export interface ScheduleState {
  tracked: Tracked[]
  quota: Quota | null
  backoff: Backoff
}

export interface TickResult {
  state: ScheduleState
  taken: { id: string; label: SnapshotLabel }[]
  error: string
}

// reads every due snapshot in batches of 50 (one videos.list call each). cost is the quota
// units a batch spends, read can throw and the error decides the backoff
export async function tick(state: ScheduleState, now: number, read: (ids: string[], labels: Map<string, SnapshotLabel>) => Promise<Reading[]>, cost: (ids: string[], labels: Map<string, SnapshotLabel>) => number): Promise<TickResult> {
  const s: ScheduleState = { tracked: state.tracked.map((t) => ({ ...t, taken: [...t.taken], missed: [...t.missed] })), quota: state.quota, backoff: state.backoff }
  const taken: TickResult['taken'] = []
  if (waiting(s.backoff, now)) return { state: s, taken, error: '' }
  const due = new Map<string, { label: SnapshotLabel; due: number }>()
  for (const t of s.tracked) {
    const p = plan(t, now)
    for (const l of p.missed) if (!t.missed.includes(l)) t.missed.push(l)
    if (p.take && p.due !== null) due.set(t.id, { label: p.take, due: p.due })
  }
  const ids = [...due.keys()]
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const labels = new Map(batch.map((id) => [id, (due.get(id) as { label: SnapshotLabel }).label]))
    const q = spend(s.quota, now, cost(batch, labels))
    if (!q) {
      s.backoff = failed(s.backoff, now, 'quota', 'TrendDeck used its share of the YouTube quota for today')
      return { state: s, taken, error: s.backoff.reason }
    }
    s.quota = q
    let readings: Reading[]
    try {
      readings = await read(batch, labels)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      s.backoff = failed(s.backoff, now, classify(err), msg)
      return { state: s, taken, error: msg }
    }
    const byId = new Map(readings.map((r) => [r.id, r]))
    for (const id of batch) {
      const r = byId.get(id)
      const t = s.tracked.find((x) => x.id === id) as Tracked
      const d = due.get(id) as { label: SnapshotLabel; due: number }
      // a video that's gone or private now: nothing to read, the label counts as missed
      if (!r) {
        t.missed.push(d.label)
        continue
      }
      t.taken.push({ label: d.label, due: d.due, at: now, views: r.views, engagedViews: r.engagedViews, likes: r.likes, comments: r.comments, avgViewPercent: r.avgViewPercent, source: r.source })
      taken.push({ id, label: d.label })
    }
  }
  s.backoff = NO_BACKOFF
  return { state: s, taken, error: '' }
}

// views at a label over the median of earlier videos at the same label
export function ageRatio(video: Tracked, others: Tracked[], label: SnapshotLabel): { ratio: number | null; views: number | null; baseline: number | null } {
  const mine = video.taken.find((s) => s.label === label)?.views ?? null
  const prior = others
    .filter((o) => o.id !== video.id && o.publishedAt < video.publishedAt)
    .sort((a, b) => a.publishedAt - b.publishedAt)
    .slice(-10)
    .map((o) => o.taken.find((s) => s.label === label)?.views)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)
  if (mine === null || prior.length < 3) return { ratio: null, views: mine, baseline: null }
  const m = Math.floor(prior.length / 2)
  const base = prior.length % 2 ? prior[m] : (prior[m - 1] + prior[m]) / 2
  return { ratio: base > 0 ? mine / base : null, views: mine, baseline: base }
}
