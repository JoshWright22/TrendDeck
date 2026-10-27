import { PLATFORMS } from '@shared/posting'
import { cleanAnalyticsDoc } from '../analytics/stats'
import { readJson } from '../analytics/files'
import { liveTokens } from '../mcp/turns'
import { getKeys } from '../posting/store'
import { getData } from '../store'
import { readSecret } from '../vault/store'

// the exact secret values main holds for a brand, so redaction can scrub them even when they
// don't look like a key. kept for a short while so a busy turn doesn't decrypt on every call
const TTL_MS = 30_000
const cache = new Map<string, { at: number; values: string[] }>()

async function collect(brandId: string): Promise<string[]> {
  const out = new Set<string>()
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim().length >= 4) out.add(v.trim())
  }
  add(getData()?.settings.youtubeApiKey)
  for (const p of PLATFORMS) for (const v of Object.values(getKeys(brandId, p))) add(v)
  const analytics = cleanAnalyticsDoc(await readJson('analytics', brandId)).config
  add(analytics.instagramToken)
  add(analytics.tiktokToken)
  const brand = getData()?.brands.find((b) => b.id === brandId)
  for (const site of brand?.sites ?? []) {
    const s = await readSecret(brandId, site.id).catch(() => null)
    if (!s) continue
    add(s.password)
    // notes hold backup codes, every line of them counts
    for (const line of s.notes.split(/\r?\n/)) add(line)
  }
  return [...out]
}

// other live secrets main holds, e.g. the craft apps' control tokens
const sources: (() => string[])[] = []

export function registerSecretSource(fn: () => string[]): void {
  sources.push(fn)
}

export async function knownSecrets(brandId: string): Promise<string[]> {
  const hit = cache.get(brandId)
  let values = hit && Date.now() - hit.at < TTL_MS ? hit.values : null
  if (!values) {
    values = await collect(brandId).catch(() => [])
    cache.set(brandId, { at: Date.now(), values })
  }
  // tokens change every turn, never cached
  return [...values, ...liveTokens(), ...sources.flatMap((fn) => fn())]
}

export function forgetSecrets(brandId?: string): void {
  if (brandId) cache.delete(brandId)
  else cache.clear()
}
