// the network rules every adapter shares: checked urls, no redirects, a timeout tied to the
// caller's cancel, capped response reads, and errors that never carry a body, url or key
import type { Fetch, SttConfig, SttField, SttModel } from './types'

export const REQUEST_TIMEOUT_MS = 120_000
export const MAX_JSON_BYTES = 1024 * 1024

// an error whose message is safe to show: status code and a plain sentence only
export class SttError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SttError'
  }
}

// ---------- urls ----------

function parseUrl(input: unknown, what: string): URL {
  if (typeof input !== 'string' || !input || input.length > 2048 || input !== input.trim() || /[\\\s]/.test(input)) {
    throw new SttError(`Enter a valid ${what}.`)
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SttError(`Enter a valid ${what}.`)
  }
  if (url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')) {
    throw new SttError(`The ${what} must not contain credentials, query parameters or fragments.`)
  }
  return url
}

export function isLoopbackHost(hostname: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname === '[::1]'
}

// a hosted API: HTTPS only
export function remoteBaseUrl(input: unknown, what = 'base URL'): URL {
  const url = parseUrl(input, what)
  if (url.protocol !== 'https:') throw new SttError(`Use an HTTPS ${what}.`)
  return url
}

// a server on this computer: 127.x, [::1], localhost pinned to 127.0.0.1. HTTP or HTTPS
export function loopbackBaseUrl(input: unknown, what = 'server URL'): URL {
  const url = parseUrl(input, what)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SttError(`Use an http:// ${what} on this computer.`)
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  if (!isLoopbackHost(url.hostname)) throw new SttError(`The ${what} must be on this computer (127.0.0.1, localhost or [::1]).`)
  return url
}

// base + '/path', keeping the base's own path (…/v1 + /audio/transcriptions)
export function joinUrl(base: URL, path: string, query?: Record<string, string>): string {
  const url = new URL(base.toString())
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`
  url.search = ''
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v)
  return url.toString()
}

// ---------- config values ----------

export function field(cfg: SttConfig, key: string, fields?: SttField[]): string {
  const raw = typeof cfg[key] === 'string' ? cfg[key].trim() : ''
  if (raw) return raw
  return fields?.find((f) => f.key === key)?.defaultValue ?? ''
}

// keys only ever go in headers, so no whitespace or control characters. '' is passed through:
// required fields are the caller's to check (missingFields), the server answers 401 otherwise
export function secret(cfg: SttConfig, key: string): string {
  const value = typeof cfg[key] === 'string' ? cfg[key].trim() : ''
  if (value.length > 8192 || /[^\x21-\x7e]/.test(value)) throw new SttError('The saved key contains invalid characters.')
  return value
}

export function modelId(model: unknown, fallback: string): string {
  const value = typeof model === 'string' && model.trim() ? model.trim() : fallback
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value)) throw new SttError('Enter a valid model name.')
  return value
}

export function languageCode(language: unknown): string {
  if (language === undefined || language === null || language === '') return ''
  if (typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(language)) throw new SttError('Unknown language.')
  return language
}

// region names, project ids and the like that end up in a host name or path
export function slug(value: string, what: string, pattern = /^[a-z0-9][a-z0-9-]{0,62}$/): string {
  if (!pattern.test(value)) throw new SttError(`Enter a valid ${what}.`)
  return value
}

// ids a server handed back, before they go into a path
export function jobId(value: unknown, provider: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new SttError(`${provider} returned an unreadable response.`)
  const id = String(value)
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new SttError(`${provider} returned an unreadable response.`)
  return id
}

const EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/flac': 'flac'
}

export function audioMime(mimeType: string): { mime: string; extension: string } {
  const mime = (mimeType || 'audio/wav').split(';')[0].trim().toLowerCase()
  return { mime, extension: EXTENSIONS[mime] ?? 'wav' }
}

export function checkAudio(audio: unknown): ArrayBuffer {
  if (!(audio instanceof ArrayBuffer) || !audio.byteLength) throw new SttError('No audio to transcribe.')
  return audio
}

// ---------- requests ----------

export interface CallOptions {
  // the provider's name for messages: "Deepgram returned HTTP 401."
  provider: string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

interface Linked {
  signal: AbortSignal
  timedOut(): boolean
  dispose(): void
}

function link(caller: AbortSignal | undefined, ms: number): Linked {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  const onAbort = (): void => controller.abort()
  if (caller?.aborted) controller.abort()
  else caller?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    }
  }
}

function statusMessage(provider: string, status: number): string {
  const hint =
    status === 401 || status === 403 ? ' Check the API key and its permissions.'
      : status === 404 ? ' Check the endpoint, region and model.'
        : status === 413 ? ' The audio is too large for this provider.'
          : status === 429 ? ' Too many requests or out of credit, try again shortly.'
            : status >= 500 ? ' The service had a problem, try again later.'
              : ''
  return `${provider} returned HTTP ${status}.${hint}`
}

function cancelled(): SttError {
  return new SttError('Transcription cancelled.')
}

async function readCapped(response: Response, maxBytes: number, provider: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new SttError(`${provider} sent a response larger than ${Math.round(maxBytes / 1024 / 1024)} MiB.`)
    }
    chunks.push(chunk.value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

async function send(fetch: Fetch, url: string, init: RequestInit, opts: CallOptions, read: boolean): Promise<{ status: number; bytes: Uint8Array }> {
  if (opts.signal?.aborted) throw cancelled()
  const linked = link(opts.signal, opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, { ...init, redirect: 'error', signal: linked.signal })
    } catch {
      // an abort lands here too, the catch below turns it into cancelled or timed out
      throw new SttError(`Could not reach ${opts.provider}. Check the connection and endpoint.`)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new SttError(statusMessage(opts.provider, response.status), response.status)
    }
    if (!read) {
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status, bytes: new Uint8Array() }
    }
    return { status: response.status, bytes: await readCapped(response, opts.maxBytes ?? MAX_JSON_BYTES, opts.provider) }
  } catch (error) {
    if (error instanceof SttError && !linked.signal.aborted) throw error
    if (linked.timedOut()) throw new SttError(`${opts.provider} did not answer within ${Math.round((opts.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)} seconds.`)
    if (opts.signal?.aborted || linked.signal.aborted) throw cancelled()
    throw new SttError(`Could not read the answer from ${opts.provider}.`)
  } finally {
    linked.dispose()
  }
}

export async function requestJson(fetch: Fetch, url: string, init: RequestInit, opts: CallOptions): Promise<unknown> {
  const { bytes } = await send(fetch, url, init, opts, true)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new SttError(`${opts.provider} returned an unreadable response.`)
  }
}

// for test(): only the status matters, the body is dropped unread
export async function requestOk(fetch: Fetch, url: string, init: RequestInit, opts: CallOptions): Promise<void> {
  await send(fetch, url, init, opts, false)
}

export async function testWith(run: () => Promise<void>, okMessage: string): Promise<{ ok: boolean; message: string }> {
  try {
    await run()
    return { ok: true, message: okMessage }
  } catch (error) {
    return { ok: false, message: error instanceof SttError ? error.message : 'The check failed.' }
  }
}

// ---------- polling ----------

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface PollDeps {
  sleep: Sleep
  now: () => number
}

export const POLL_TIMEOUT_MS = 15 * 60_000
export const defaultPollDeps: PollDeps = { sleep, now: () => Date.now() }

// calls step until it returns a value, waiting 1 s, 1.5 s, … up to 5 s between tries
export async function poll<T>(
  step: () => Promise<T | undefined>, opts: { provider: string; signal?: AbortSignal; deps: PollDeps; timeoutMs?: number }
): Promise<T> {
  const deadline = opts.deps.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS)
  let wait = 1000
  for (;;) {
    if (opts.signal?.aborted) throw cancelled()
    const value = await step()
    if (value !== undefined) return value
    if (opts.deps.now() + wait > deadline) throw new SttError(`${opts.provider} did not finish the transcript in time.`)
    await opts.deps.sleep(wait, opts.signal)
    wait = Math.min(5000, Math.round(wait * 1.5))
  }
}

// ---------- model lists ----------

export function dedupeModels(models: SttModel[]): SttModel[] {
  const seen = new Set<string>()
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : []
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
