import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PLATFORMS, type PostItem } from '@shared/posting'
import { DEFAULT_PACE, type PaceSettings } from '@shared/reuse'

const FILE = 'reuse-pace.json'
const DAY = 24 * 60 * 60 * 1000

let pace: PaceSettings = structuredClone(DEFAULT_PACE)

const num = (v: unknown, min: number, max: number, def: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def
}

export function cleanPace(raw: unknown): PaceSettings {
  const r = raw as Partial<PaceSettings> | null
  const out = structuredClone(DEFAULT_PACE)
  if (!r || typeof r !== 'object') return out
  for (const p of PLATFORMS) {
    const rule = r.rules?.[p]
    if (!rule) continue
    // 0 per day means no limit
    out.rules[p] = {
      perDay: num(rule.perDay, 0, 100, out.rules[p].perDay),
      gapMinutes: num(rule.gapMinutes, 0, 1440, out.rules[p].gapMinutes)
    }
  }
  out.jitterMinutes = num(r.jitterMinutes, 0, 120, out.jitterMinutes)
  return out
}

export async function loadPace(): Promise<PaceSettings> {
  try {
    pace = cleanPace(JSON.parse(await fs.readFile(join(app.getPath('userData'), FILE), 'utf8')))
  } catch {
    pace = structuredClone(DEFAULT_PACE)
  }
  return pace
}

export async function savePace(raw: unknown): Promise<PaceSettings> {
  pace = cleanPace(raw)
  const file = join(app.getPath('userData'), FILE)
  await fs.writeFile(`${file}.tmp`, JSON.stringify(pace, null, 2), 'utf8')
  await fs.rename(`${file}.tmp`, file)
  return pace
}

// null when the post can go now, otherwise the new time and why
export function holdFor(
  post: PostItem,
  all: PostItem[],
  now: number,
  rules: PaceSettings = pace,
  rand: () => number = Math.random
): { at: number; note: string } | null {
  const rule = rules.rules[post.platform]
  const same = all.filter(
    (p) => p.id !== post.id && p.brandId === post.brandId && p.platform === post.platform
  )
  // posts going out right now count as just posted
  const times = same
    .filter((p) => p.status === 'posted' || p.status === 'running' || p.status === 'review' || p.status === 'queued')
    .map((p) => (p.status === 'posted' ? p.updatedAt : now))
    .sort((a, b) => b - a)
  let at = 0
  let note = ''
  if (rule.gapMinutes && times.length && now - times[0] < rule.gapMinutes * 60000) {
    at = times[0] + rule.gapMinutes * 60000
    note = `held back, ${rule.gapMinutes} min gap between posts`
  }
  const today = times.filter((t) => now - t < DAY)
  if (rule.perDay && today.length >= rule.perDay) {
    // waits until the oldest one in the window drops out
    const free = today[rule.perDay - 1] + DAY
    if (free > at) {
      at = free
      note = `held back, ${rule.perDay} a day limit`
    }
  }
  if (!at) return null
  at += Math.round(rand() * rules.jitterMinutes * 60000)
  return { at, note }
}

export const paceHold = (post: PostItem, all: PostItem[], now: number): { at: number; note: string } | null =>
  holdFor(post, all, now)
