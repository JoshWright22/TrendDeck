import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ProviderId } from '@shared/visuals'

// network for visuals: provider searches and downloads. only public http(s) hosts, redirects
// checked hop by hop, a size cap, a timeout, and a polite pace per provider. node's fetch, so a
// script can run it without electron

export class VisualNetError extends Error {}

let userAgent = 'TrendDeck/dev (https://github.com/JoshWright22/TrendDeck)'
export function setUserAgent(version: string): void {
  userAgent = `TrendDeck/${version} (https://github.com/JoshWright22/TrendDeck)`
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

function privateV6(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === '::' || s === '::1') return true
  if (s.startsWith('::ffff:')) return privateV4(s.slice(7))
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s)
}

export function privateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return privateV4(ip)
  if (v === 6) return privateV6(ip)
  return true
}

// a url TrendDeck may fetch for a visual: http(s), a public host, the usual ports
export async function checkUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new VisualNetError("That isn't a link.")
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new VisualNetError('Only web links work here.')
  if (u.username || u.password) throw new VisualNetError("Links with a sign-in in them aren't fetched.")
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new VisualNetError("That link's port isn't allowed.")
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || /\.(local|localhost|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !isIP(host)) {
    throw new VisualNetError('Links to this computer or your network are not fetched.')
  }
  if (isIP(host)) {
    if (privateAddress(host)) throw new VisualNetError('Links to this computer or your network are not fetched.')
    return u
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new VisualNetError(`Couldn't reach ${host}.`)
  }
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new VisualNetError('Links to this computer or your network are not fetched.')
  return u
}

export interface Fetched {
  bytes: Buffer
  mime: string
  url: string
}

// fetches a public url with a cap. redirects are followed by hand so every hop gets checked
export async function safeFetch(
  url: string,
  opts: { headers?: Record<string, string>; maxBytes: number; timeoutMs?: number; accept?: (mime: string) => boolean }
): Promise<Fetched> {
  let current = url
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000)
  try {
    for (let hop = 0; hop < 6; hop++) {
      const u = await checkUrl(current)
      let res: Response
      try {
        res = await fetch(u, { headers: { 'User-Agent': userAgent, Accept: '*/*', ...(hop === 0 ? opts.headers : {}) }, redirect: 'manual', signal: ctl.signal })
      } catch (err) {
        if (ctl.signal.aborted) throw new VisualNetError('That took too long. Try again.')
        throw new VisualNetError(`Couldn't download it from ${u.hostname}: ${err instanceof Error ? err.message : 'network error'}.`)
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!loc) throw new VisualNetError('The link redirected nowhere.')
        current = new URL(loc, u).href
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new VisualNetError(res.status === 404 ? "That file isn't there anymore." : res.status === 429 ? 'The site says too many downloads. Try again in a minute.' : `The download failed (HTTP ${res.status}).`)
      }
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (opts.accept && !opts.accept(mime)) {
        await res.body?.cancel().catch(() => {})
        throw new VisualNetError(`That link is ${mime || 'an unknown type'}, not the file that was expected.`)
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > opts.maxBytes) {
        await res.body?.cancel().catch(() => {})
        throw new VisualNetError(`That file is ${Math.round(len / 1_000_000)} MB, over the ${Math.round(opts.maxBytes / 1_000_000)} MB limit.`)
      }
      const chunks: Buffer[] = []
      let total = 0
      const reader = res.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > opts.maxBytes) {
            await reader.cancel().catch(() => {})
            throw new VisualNetError(`That file is over the ${Math.round(opts.maxBytes / 1_000_000)} MB limit.`)
          }
          chunks.push(Buffer.from(value))
        }
      }
      return { bytes: Buffer.concat(chunks), mime, url: current }
    }
    throw new VisualNetError('Too many redirects.')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 12_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', ...headers }, signal: ctl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch {
    throw new VisualNetError(ctl.signal.aborted ? 'The search took too long.' : "Couldn't reach the service. Check your connection.")
  } finally {
    clearTimeout(timer)
  }
}

// how often each provider may be asked, from their published limits with room to spare.
// Openverse without a key and Wikimedia ask for a slow, polite pace; Pexels allows 200 an hour,
// Pixabay 100 a minute
const LIMITS: Record<ProviderId, { gapMs: number; perHour: number }> = {
  openverse: { gapMs: 1500, perHour: 100 },
  wikimedia: { gapMs: 500, perHour: 500 },
  pexels: { gapMs: 500, perHour: 180 },
  pixabay: { gapMs: 700, perHour: 1500 }
}

export class Pace {
  private last = new Map<ProviderId, number>()
  private hour = new Map<ProviderId, number[]>()
  private blockedUntil = new Map<ProviderId, number>()

  constructor(private now: () => number = Date.now) {}

  // null when the provider can be asked now (and counts it), otherwise how long to wait
  take(p: ProviderId): number | null {
    const t = this.now()
    const blocked = this.blockedUntil.get(p) ?? 0
    if (blocked > t) return blocked - t
    const recent = (this.hour.get(p) ?? []).filter((x) => t - x < 3_600_000)
    if (recent.length >= LIMITS[p].perHour) return 3_600_000 - (t - recent[0])
    const wait = (this.last.get(p) ?? 0) + LIMITS[p].gapMs - t
    if (wait > 0) return wait
    recent.push(t)
    this.hour.set(p, recent)
    this.last.set(p, t)
    return null
  }

  // a 429 from the provider: leave it alone for a while
  backOff(p: ProviderId, ms: number): void {
    this.blockedUntil.set(p, this.now() + Math.max(10_000, Math.min(ms, 3_600_000)))
  }
}
