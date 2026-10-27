import { randomUUID } from 'node:crypto'
import {
  LICENSE_FILTERS,
  ORIENTATIONS,
  PROVIDER_KINDS,
  PROVIDER_NAMES,
  PROVIDERS,
  isProvider,
  isVisualKind,
  type ProviderId,
  type ProviderNote,
  type VisualResult,
  type VisualSearch,
  type VisualSearchInput
} from '@shared/visuals'
import { fetchJson, Pace, safeFetch, VisualNetError } from './net'
import { interleave, PARSERS, providerError, REQUESTS, type SearchQuery } from './providers'
import { cachedThumb, rememberResults, saveThumb, VisualError } from './store'

// one search across the providers that can do the kind: polite pace per provider, answers cached
// for a day (Pixabay asks for that), thumbnails downloaded once so the window never loads a remote
// image. no electron, the keys and folders come in as arguments

export type KeyFn = (p: ProviderId) => Promise<string>

const pace = new Pace()
const DAY = 24 * 3_600_000
const cache = new Map<string, { at: number; results: VisualResult[] }>()

export function cleanInput(raw: VisualSearchInput): SearchQuery & { providers: ProviderId[] | null } {
  const query = typeof raw?.query === 'string' ? raw.query.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  if (!query) throw new VisualError('Type what to look for.')
  if (!isVisualKind(raw.kind)) throw new VisualError('Pick images, videos, GIFs or audio.')
  const orientation = (ORIENTATIONS as readonly unknown[]).includes(raw.orientation) ? raw.orientation! : null
  const license = (LICENSE_FILTERS as readonly unknown[]).includes(raw.license) ? raw.license! : 'any-free'
  const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.max(1, Math.min(24, Math.round(raw.count))) : 12
  const providers = Array.isArray(raw.providers) ? raw.providers.filter(isProvider) : null
  return { query, kind: raw.kind, orientation, license, count, providers: providers?.length ? providers : null }
}

async function one(p: ProviderId, q: SearchQuery, key: string): Promise<{ note: ProviderNote; results: VisualResult[] }> {
  const note = (state: ProviderNote['state'], text: string, count = 0): ProviderNote => ({ provider: p, state, note: text, count })
  if (!PROVIDER_KINDS[p].includes(q.kind)) return { note: note('skipped', `${PROVIDER_NAMES[p]} has no ${q.kind} search.`), results: [] }
  const req = REQUESTS[p](q, key)
  if (!req) return { note: note('skipped', `Add a free ${PROVIDER_NAMES[p]} key in Settings, Media sources.`), results: [] }
  // the cache key never holds the api key
  const ck = `${p}|${q.kind}|${q.orientation ?? ''}|${q.license}|${q.count}|${q.query.toLowerCase()}`
  const hit = cache.get(ck)
  if (hit && Date.now() - hit.at < DAY) return { note: note('ok', 'From a search in the last day.', hit.results.length), results: hit.results }
  const wait = pace.take(p)
  if (wait !== null) {
    if (wait > 4000) return { note: note('failed', `Not asked this time, try ${PROVIDER_NAMES[p]} again in ${Math.ceil(wait / 60_000)} min.`), results: [] }
    await new Promise((r) => setTimeout(r, wait))
    pace.take(p)
  }
  try {
    const res = await fetchJson(req.url, req.headers)
    if (res.status === 429) pace.backOff(p, 60_000)
    // a provider that is down is left alone for two minutes, so searches stay quick
    if (res.status >= 500) pace.backOff(p, 120_000)
    if (res.status < 200 || res.status >= 300) return { note: note('failed', providerError(res.status, p)), results: [] }
    const results = PARSERS[p](res.body, q)
    cache.set(ck, { at: Date.now(), results })
    if (cache.size > 300) cache.delete(cache.keys().next().value!)
    return { note: note('ok', '', results.length), results }
  } catch (err) {
    pace.backOff(p, 120_000)
    return { note: note('failed', `${err instanceof VisualNetError ? err.message : 'The search failed.'} Skipped for a couple of minutes.`), results: [] }
  }
}

// thumbnails of the results into the cache, a few at a time. a result whose thumbnail won't load
// just shows its title
async function cacheThumbs(root: string, brandId: string, results: VisualResult[]): Promise<void> {
  const queue = results.filter((r) => r.thumbUrl)
  const work = async (): Promise<void> => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const have = await cachedThumb(root, brandId, r.thumbUrl)
      if (have) {
        r.thumb = have
        continue
      }
      try {
        const f = await safeFetch(r.thumbUrl, { maxBytes: 4_000_000, timeoutMs: 20_000, accept: (m) => m.startsWith('image/') || m === 'application/octet-stream' || m === '' })
        r.thumb = await saveThumb(root, brandId, r.thumbUrl, f.bytes)
      } catch {
        // no thumbnail for this one
      }
    }
  }
  await Promise.all([work(), work(), work(), work()])
}

export async function searchVisuals(root: string, brandId: string, raw: VisualSearchInput, keyOf: KeyFn): Promise<VisualSearch> {
  const q = cleanInput(raw)
  const which = (q.providers ?? [...PROVIDERS]).filter((p) => PROVIDER_KINDS[p].includes(q.kind))
  const outs = await Promise.all(which.map(async (p) => one(p, q, await keyOf(p).catch(() => ''))))
  // copies, the cached answers stay as the providers gave them
  const results = interleave(outs.map((o) => o.results), q.count).map((r) => ({ ...r }))
  await cacheThumbs(root, brandId, results)
  await rememberResults(root, brandId, results)
  return {
    id: randomUUID(),
    input: { query: q.query, kind: q.kind, orientation: q.orientation, license: q.license, count: q.count },
    results,
    providers: outs.map((o) => o.note),
    at: Date.now()
  }
}

// the most a downloaded option may weigh
export const MAX_DOWNLOAD: Record<VisualResult['kind'], number> = {
  image: 40_000_000,
  gif: 40_000_000,
  audio: 80_000_000,
  video: 400_000_000
}

const MIME_OK: Record<VisualResult['kind'], (m: string) => boolean> = {
  image: (m) => m.startsWith('image/') || m === 'application/octet-stream' || m === 'binary/octet-stream' || m === '',
  gif: (m) => m === 'image/gif' || m === 'application/octet-stream' || m === '',
  video: (m) => m.startsWith('video/') || m === 'application/ogg' || m === 'application/octet-stream' || m === 'binary/octet-stream' || m === '',
  audio: (m) => m.startsWith('audio/') || m === 'application/ogg' || m === 'application/octet-stream' || m === 'binary/octet-stream' || m === ''
}

export async function downloadResult(r: VisualResult): Promise<{ bytes: Buffer; mime: string }> {
  const f = await safeFetch(r.fileUrl, { maxBytes: MAX_DOWNLOAD[r.kind], timeoutMs: r.kind === 'video' ? 300_000 : 90_000, accept: MIME_OK[r.kind] })
  if (!f.bytes.length) throw new VisualNetError('The download was empty.')
  return { bytes: f.bytes, mime: f.mime }
}

// a short readable list for the agent
export function resultsText(s: VisualSearch): string {
  const lines = [`${s.results.length} ${s.input.kind} option(s) for "${s.input.query}" are in the chat as a grid the user can pick from.`]
  s.results.forEach((r, i) => {
    const size = [r.width && r.height ? `${r.width}x${r.height}` : '', r.duration ? `${Math.round(r.duration)}s` : ''].filter(Boolean).join(', ')
    lines.push(
      `${i + 1}. ${r.id}: "${r.title}" by ${r.author || 'unknown'}, ${PROVIDER_NAMES[r.provider]}, ${r.license.name}${r.license.attribution ? ' (credit needed)' : ''}${r.license.commercial ? '' : ' (not for commercial use)'}${size ? `, ${size}` : ''}. ${r.pageUrl}`
    )
  })
  const off = s.providers.filter((p) => p.state !== 'ok')
  if (off.length) lines.push('', ...off.map((p) => `${PROVIDER_NAMES[p.provider]}: ${p.note}`))
  lines.push('', 'Look at one with visual_get (its id), put one in the video files with visual_save, and list credits with visual_credits.')
  return lines.join('\n')
}
