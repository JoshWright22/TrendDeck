import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

// Google's desktop OAuth flow: a one-off server on 127.0.0.1 takes the redirect, PKCE keeps the
// code useless to anyone else, and the tokens stay in main. the browser is the creator's own,
// TrendDeck never sees their Google password. read-only scopes. no electron here, main passes
// in how to open the browser and how to post the token request

export const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly']
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const WAIT_MS = 5 * 60_000

export interface Client {
  id: string
  secret: string
}

export interface Tokens {
  access: string
  refresh: string
  // ms epoch
  expiresAt: number
  scope: string
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl(clientId: string, redirect: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    // a refresh token every time, so connecting again after a disconnect works
    prompt: 'consent'
  })
  return `${AUTH_URL}?${q.toString()}`
}

// what came back on the redirect, checked against the state we sent
export function readCallback(path: string, state: string): { code: string } | { error: string } | null {
  let u: URL
  try {
    u = new URL(path, 'http://127.0.0.1')
  } catch {
    return null
  }
  if (u.pathname !== '/') return null
  const error = u.searchParams.get('error')
  if (error) return { error: error === 'access_denied' ? 'You turned down the Google sign-in.' : `Google said ${error}.` }
  const code = u.searchParams.get('code')
  if (!code) return null
  if (u.searchParams.get('state') !== state) return { error: "The sign-in reply didn't match this request. Try again." }
  return { code }
}

export function parseTokens(raw: unknown, now: number, previous?: Tokens): Tokens {
  const r = raw as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown; error_description?: unknown } | null
  if (!r || typeof r.access_token !== 'string' || !r.access_token) {
    const why = typeof r?.error_description === 'string' ? r.error_description : typeof r?.error === 'string' ? r.error : 'no access token'
    throw new Error(`Google sign-in failed: ${why}`)
  }
  const refresh = typeof r.refresh_token === 'string' && r.refresh_token ? r.refresh_token : (previous?.refresh ?? '')
  if (!refresh) throw new Error('Google gave no refresh token. Remove TrendDeck from your Google account permissions and connect again.')
  const secs = typeof r.expires_in === 'number' ? r.expires_in : Number(r.expires_in) || 3600
  const scope = typeof r.scope === 'string' ? r.scope : (previous?.scope ?? '')
  return { access: r.access_token, refresh, expiresAt: now + Math.max(60, secs - 60) * 1000, scope }
}

// the scopes Google actually granted, the creator can untick one on the consent page
export function missingScopes(scope: string): string[] {
  const got = new Set(scope.split(/\s+/))
  return SCOPES.filter((s) => !got.has(s))
}

export type PostForm = (url: string, form: Record<string, string>) => Promise<unknown>

const PAGE = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>TrendDeck</title><body style="background:#0a0a0a;color:#ececec;font:15px 'Segoe UI Variable',system-ui,sans-serif;padding:48px"><p>${msg}</p><p style="color:#b0b0b0">You can close this tab and go back to TrendDeck.</p></body>`

export interface FlowDeps {
  open: (url: string) => Promise<void> | void
  post: PostForm
  now: () => number
  // aborts the wait, e.g. the app quitting
  signal?: AbortSignal
}

// the whole sign-in: listen, open the browser, wait for the redirect, swap the code for tokens
export async function signIn(client: Client, deps: FlowDeps): Promise<Tokens> {
  if (!client.id) throw new Error('Add your Google OAuth client ID first.')
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  let server: Server | null = null
  try {
    const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
      let redirect = ''
      const timer = setTimeout(() => reject(new Error('No answer from Google within 5 minutes. Try again.')), WAIT_MS)
      deps.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('Sign-in cancelled.'))
      })
      server = createServer((req, res) => {
        const r = readCallback(req.url ?? '/', state)
        if (!r) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE('error' in r ? r.error : 'TrendDeck is connected to your YouTube channel.'))
        clearTimeout(timer)
        if ('error' in r) reject(new Error(r.error))
        else resolve({ code: r.code, redirect })
      })
      server.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('Could not open a local port for the sign-in.'))
          return
        }
        redirect = `http://127.0.0.1:${addr.port}`
        Promise.resolve(deps.open(authUrl(client.id, redirect, challenge, state))).catch(reject)
      })
    })
    const raw = await deps.post(TOKEN_URL, {
      code,
      client_id: client.id,
      ...(client.secret ? { client_secret: client.secret } : {}),
      redirect_uri: redirect,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
    return parseTokens(raw, deps.now())
  } finally {
    ;(server as Server | null)?.close()
  }
}

export async function refresh(client: Client, tokens: Tokens, post: PostForm, now: number): Promise<Tokens> {
  const raw = await post(TOKEN_URL, {
    client_id: client.id,
    ...(client.secret ? { client_secret: client.secret } : {}),
    refresh_token: tokens.refresh,
    grant_type: 'refresh_token'
  })
  return parseTokens(raw, now, tokens)
}
