import { createHash } from 'node:crypto'

export function normalizeEndpoint(input: string): string {
  let endpoint: URL
  try { endpoint = new URL(input) } catch { throw new Error('OBS endpoint must be a loopback ws:// URL') }
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('OBS endpoint must be ws://localhost, ws://127.0.0.1 or ws://[::1], without credentials or a path')
  }
  if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1'
  return endpoint.toString()
}

export function authentication(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64')
  return createHash('sha256').update(secret + challenge).digest('base64')
}

// OBS v5 event subscription bits, see EventSubscription in the protocol docs
export const EVENTS = { config: 1 << 1, scenes: 1 << 2, inputs: 1 << 3, outputs: 1 << 6 } as const

// a request OBS answered with a failure: the outcome is known, nothing happened. a timeout or a
// dropped connection is a plain Error instead, because then the outcome is unknown
export class ObsRequestError extends Error {
  readonly definite = true
  constructor(message: string, readonly code: number) { super(message) }
}

// by shape too, so it holds across module copies (tests reset modules)
export const isRequestError = (err: unknown): err is ObsRequestError =>
  err instanceof ObsRequestError || (err instanceof Error && (err as { definite?: unknown }).definite === true)

export function identify(hello: Record<string, unknown>, password?: string, eventSubscriptions = 0): Record<string, unknown> {
  if (typeof hello.rpcVersion !== 'number' || hello.rpcVersion < 1) throw new Error('OBS WebSocket v5 RPC 1 is required')
  const data: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions }
  if (hello.authentication !== undefined) {
    const auth = hello.authentication as Record<string, unknown> | null
    if (!auth || typeof auth.salt !== 'string' || typeof auth.challenge !== 'string') throw new Error('Invalid OBS authentication challenge')
    if (!password) throw new Error('OBS requires a password. Import it from local OBS in connection settings')
    data.authentication = authentication(password, auth.salt, auth.challenge)
  }
  return { op: 1, d: data }
}

export interface ObsFrame { op: number; d: Record<string, unknown> }

export function parseFrame(text: string): ObsFrame {
  const frame = JSON.parse(text) as ObsFrame
  if (!frame || typeof frame.op !== 'number' || !frame.d || typeof frame.d !== 'object' || Array.isArray(frame.d)) {
    throw new Error('Invalid OBS WebSocket message')
  }
  return frame
}

export function responseData(data: Record<string, unknown>, requestType: string): Record<string, unknown> {
  const status = data.requestStatus as { result?: boolean; code?: number } | undefined
  if (data.requestType !== requestType || !status || typeof status.result !== 'boolean') throw new Error('Invalid OBS request response')
  if (!status.result) {
    const code = Number(status.code) || 0
    throw new ObsRequestError(`OBS ${requestType} failed (code ${code || 'unknown'}). Check OBS settings and output state`, code)
  }
  return (data.responseData ?? {}) as Record<string, unknown>
}
