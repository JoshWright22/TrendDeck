import type { BaselineSummary, Flag, GroupStat, MapRow, MapVideo, Pillar, WhatWorked } from '@shared/content-map'

// the channel's own baseline and how each video did against it. like YouTube's "typical"
// numbers: each video is compared with the median of the channel's recent comparable videos
// (same platform and format) published before it, never with industry averages. pure, tested

const DAY = 24 * 3600_000
// a video younger than this hasn't settled, it's shown but not flagged
export const SETTLE_MS = 7 * DAY
// how many earlier comparable videos make the baseline
export const BASELINE_WINDOW = 10
// fewer earlier ones than this and the format's overall median stands in
const MIN_PRIOR = 3
export const TOP_RATIO = 1.5
export const BOTTOM_RATIO = 0.6

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// the number a video is judged on: engaged views for Shorts when the platform gives them
export function score(v: MapVideo): number | null {
  const m = v.metrics
  if (!m) return null
  if (v.format === 'short' && m.engagedViews !== null) return m.engagedViews
  return m.views
}

const groupKey = (v: MapVideo): string => `${v.platform}:${v.format}`

export interface Rated {
  ratio: number | null
  baseline: number | null
  flag: Flag
}

// every video's ratio against the median of up to 10 comparable videos published before it
export function rate(videos: MapVideo[], now: number): Map<string, Rated> {
  const out = new Map<string, Rated>()
  const groups = new Map<string, MapVideo[]>()
  for (const v of videos) {
    if (v.platform === 'local') {
      out.set(v.id, { ratio: null, baseline: null, flag: 'none' })
      continue
    }
    const list = groups.get(groupKey(v)) ?? []
    list.push(v)
    groups.set(groupKey(v), list)
  }
  for (const list of groups.values()) {
    const dated = list.filter((v) => v.publishedAt !== null && score(v) !== null).sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
    // settled videos only: a 2 day old video's views would pull the baseline down
    const settled = dated.filter((v) => now - (v.publishedAt ?? 0) >= SETTLE_MS)
    for (const v of list) {
      const s = score(v)
      if (s === null) {
        out.set(v.id, { ratio: null, baseline: null, flag: 'none' })
        continue
      }
      const before = settled.filter((p) => p.id !== v.id && (v.publishedAt === null || (p.publishedAt ?? 0) < v.publishedAt)).slice(-BASELINE_WINDOW)
      // too few earlier ones: the format's other settled videos, never the video itself
      const pool = before.length >= MIN_PRIOR ? before : settled.filter((p) => p.id !== v.id)
      const base = median(pool.map((p) => score(p) as number))
      if (base === null || base <= 0) {
        out.set(v.id, { ratio: null, baseline: base, flag: 'none' })
        continue
      }
      const ratio = s / base
      const young = v.publishedAt !== null && now - v.publishedAt < SETTLE_MS
      const flag: Flag = young ? 'early' : ratio >= TOP_RATIO ? 'top' : ratio <= BOTTOM_RATIO ? 'bottom' : 'normal'
      out.set(v.id, { ratio, baseline: base, flag })
    }
  }
  return out
}

// the baseline right now, per platform and format, for the map's header
export function baselines(videos: MapVideo[], now: number): BaselineSummary[] {
  const out: BaselineSummary[] = []
  const groups = new Map<string, MapVideo[]>()
  for (const v of videos) {
    if (v.platform === 'local') continue
    const list = groups.get(groupKey(v)) ?? []
    list.push(v)
    groups.set(groupKey(v), list)
  }
  for (const list of groups.values()) {
    const recent = list
      .filter((v) => v.publishedAt !== null && score(v) !== null && now - (v.publishedAt ?? 0) >= SETTLE_MS)
      .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
      .slice(-BASELINE_WINDOW)
    const first = list[0]
    out.push({
      platform: first.platform,
      format: first.format,
      median: median(recent.map((v) => score(v) as number)),
      count: recent.length,
      metric: first.format === 'short' && list.some((v) => v.metrics?.engagedViews != null) ? 'engaged views' : 'views'
    })
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform) || a.format.localeCompare(b.format))
}

// ---------- words, styles and pillars ----------

const STOP = new Set(
  'a an and are as at be but by for from has have how i if in into is it its just me my no not of on or our out so than that the their them then there these they this to too up us was we what when where which who why will with you your yours ive im its dont cant wont vs get got make made new video videos part ep episode shorts short'.split(
    ' '
  )
)

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
}

// the hook's style from what's said first, one plain label
export function hookStyle(hook: string): string {
  const t = hook.trim().toLowerCase()
  if (!t) return 'unknown'
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? t
  if (/\?/.test(first)) return 'question'
  if (/^(so |when |last |yesterday|i was|i've been|i spent|i tried|this is the story|a few)/.test(first)) return 'story'
  if (/\b(how to|here's how|step|let me show|i'll show)\b/.test(first)) return 'how-to'
  if (/^\d|\b(\d+|one|two|three|five|ten) (ways|things|reasons|mistakes|tips|steps)\b/.test(first)) return 'list'
  if (/^(you|your|if you)\b/.test(first)) return 'talks to you'
  if (/\b(never|always|everyone|nobody|wrong|stop|best|worst|secret|truth)\b/.test(first)) return 'bold claim'
  return 'statement'
}

export function titleStyle(title: string): string {
  const t = title.trim()
  if (!t) return 'unknown'
  if (/^how to\b/i.test(t) || /\b(guide|tutorial)\b/i.test(t)) return 'how-to'
  if (/\?\s*$/.test(t) || /^(why|how|what|is|are|can|should|do|does)\b/i.test(t)) return 'question'
  if (/^\d+\b|\b\d+ (ways|things|tips|mistakes|reasons|steps)\b/i.test(t)) return 'number'
  if (/^(i|i'm|i've|my|we)\b/i.test(t)) return 'first person'
  if (/[:|(\[]/.test(t)) return 'two-part'
  return 'statement'
}

// recurring words across titles and tags, what pillars get proposed from
export function topKeywords(videos: MapVideo[], max = 25): { word: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const v of videos) {
    const seen = new Set([...words(v.title), ...v.tags.flatMap((t) => words(t))])
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word, count]) => ({ word, count }))
}

// the pillar whose keywords the video's title, tags and description hit most. title hits count double
export function pillarFor(v: MapVideo, pillars: Pillar[]): Pillar | null {
  if (!pillars.length) return null
  const title = new Set(words(v.title))
  const rest = new Set([...v.tags.flatMap((t) => words(t)), ...words(v.description.slice(0, 400)), ...words(v.hook)])
  let best: Pillar | null = null
  let bestScore = 0
  for (const p of pillars) {
    let s = 0
    for (const k of p.keywords) {
      const kw = words(k)
      if (!kw.length) continue
      // a multi word keyword hits when all its words are there
      if (kw.every((w) => title.has(w))) s += 2
      else if (kw.every((w) => title.has(w) || rest.has(w))) s += 1
    }
    if (s > bestScore) {
      best = p
      bestScore = s
    }
  }
  return best
}

// ---------- rows and groups ----------

export function rows(videos: MapVideo[], pillars: Pillar[], now: number): MapRow[] {
  const rated = rate(videos, now)
  return videos
    .map((v) => {
      const r = rated.get(v.id) ?? { ratio: null, baseline: null, flag: 'none' as Flag }
      return {
        id: v.id,
        platform: v.platform,
        title: v.title,
        url: v.url,
        publishedAt: v.publishedAt,
        format: v.format,
        duration: v.duration,
        views: v.metrics?.views ?? null,
        avgViewPercent: v.metrics?.avgViewPercent ?? null,
        ratio: r.ratio,
        baseline: r.baseline,
        flag: r.flag,
        pillar: pillarFor(v, pillars)?.label ?? null,
        hookStyle: hookStyle(v.hook),
        titleStyle: titleStyle(v.title),
        projectId: v.projectId,
        hasRetention: v.retention.length > 1
      }
    })
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
}

export function groupStat(key: string, list: MapRow[]): GroupStat {
  // only settled videos with numbers say what worked
  const judged = list.filter((r) => r.ratio !== null && r.flag !== 'early')
  const ratios = judged.map((r) => r.ratio as number)
  return {
    key,
    count: list.length,
    median: median(ratios),
    beat: judged.length ? ratios.filter((x) => x > 1).length / judged.length : null,
    best: [...judged]
      .sort((a, b) => (b.ratio as number) - (a.ratio as number))
      .slice(0, 3)
      .map((r) => ({ id: r.id, title: r.title, ratio: r.ratio as number }))
  }
}

function groupBy(list: MapRow[], key: (r: MapRow) => string): GroupStat[] {
  const groups = new Map<string, MapRow[]>()
  for (const r of list) {
    const k = key(r)
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.entries()].map(([k, rs]) => groupStat(k, rs)).sort((a, b) => (b.median ?? -1) - (a.median ?? -1) || b.count - a.count)
}

export function whatWorked(list: MapRow[], filter: { format?: string; pillar?: string } = {}): WhatWorked {
  const rs = list.filter((r) => r.platform !== 'local' && (!filter.format || r.format === filter.format) && (!filter.pillar || (r.pillar ?? '').toLowerCase() === filter.pillar.toLowerCase()))
  return {
    pillar: groupBy(rs, (r) => r.pillar ?? 'No pillar'),
    format: groupBy(rs, (r) => r.format),
    hookStyle: groupBy(rs, (r) => r.hookStyle),
    titleStyle: groupBy(rs, (r) => r.titleStyle)
  }
}

// ---------- similar videos ----------

// tf-idf cosine over titles, tags, hooks and descriptions. good enough to find "the one about X"
export function similar(videos: MapVideo[], text: string, max = 5): { video: MapVideo; score: number }[] {
  const docs = videos.map((v) => {
    const ws = [...words(v.title), ...words(v.title), ...v.tags.flatMap((t) => words(t)), ...words(v.hook), ...words(v.description.slice(0, 600))]
    const tf = new Map<string, number>()
    for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1)
    return tf
  })
  const df = new Map<string, number>()
  for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) ?? 0) + 1)
  const idf = (w: string): number => Math.log((docs.length + 1) / ((df.get(w) ?? 0) + 1)) + 1
  const vec = (tf: Map<string, number>): Map<string, number> => new Map([...tf].map(([w, n]) => [w, n * idf(w)]))
  const norm = (m: Map<string, number>): number => Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0))
  const qtf = new Map<string, number>()
  for (const w of words(text)) qtf.set(w, (qtf.get(w) ?? 0) + 1)
  const q = vec(qtf)
  const qn = norm(q)
  if (!qn) return []
  return docs
    .map((d, i) => {
      const dv = vec(d)
      let dot = 0
      for (const [w, x] of q) dot += x * (dv.get(w) ?? 0)
      const dn = norm(dv)
      return { video: videos[i], score: dn ? dot / (qn * dn) : 0 }
    })
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => ({ video: x.video, score: Math.round(x.score * 100) / 100 }))
}

// a project name to the post it became: most of the project name's words in the title
export function matchProject(title: string, projects: { id: string; name: string }[]): string | null {
  const tw = new Set(words(title))
  let best: string | null = null
  let bestScore = 0
  for (const p of projects) {
    const pw = [...new Set(words(p.name))]
    if (!pw.length) continue
    const hit = pw.filter((w) => tw.has(w)).length / pw.length
    if (hit > bestScore) {
      best = p.id
      bestScore = hit
    }
  }
  return bestScore >= 0.6 ? best : null
}
