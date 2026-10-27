import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authUrl, missingScopes, parseTokens, pkce, readCallback, refresh, SCOPES, signIn, TOKEN_URL } from './oauth'

// the desktop loopback flow, run against a fake Google: the "browser" follows the redirect to the
// local server and the token endpoint is a function. no real account, credentials blank

describe('OAuth pieces', () => {
  it('makes a PKCE pair whose challenge is the sha256 of the verifier', () => {
    const { verifier, challenge } = pkce()
    expect(verifier).toMatch(/^[\w-]{43,128}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('asks for read-only scopes, offline access and S256', () => {
    const u = new URL(authUrl('id.apps.googleusercontent.com', 'http://127.0.0.1:5000', 'chal', 'st'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(SCOPES)
    expect(SCOPES.every((s) => s.endsWith('.readonly'))).toBe(true)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000')
  })

  it('checks the redirect: state must match, a no from the user says so', () => {
    expect(readCallback('/?code=abc&state=s1', 's1')).toEqual({ code: 'abc' })
    expect(readCallback('/?code=abc&state=other', 's1')).toEqual({ error: expect.stringMatching(/didn't match/) })
    expect(readCallback('/?error=access_denied&state=s1', 's1')).toEqual({ error: 'You turned down the Google sign-in.' })
    expect(readCallback('/favicon.ico', 's1')).toBeNull()
    expect(readCallback('/', 's1')).toBeNull()
  })

  it('reads token answers and keeps the old refresh token on refresh', () => {
    const t = parseTokens({ access_token: 'a1', refresh_token: 'r1', expires_in: 3599, scope: SCOPES.join(' ') }, 0)
    expect(t).toEqual({ access: 'a1', refresh: 'r1', expiresAt: 3539_000, scope: SCOPES.join(' ') })
    expect(parseTokens({ access_token: 'a2', expires_in: 3599 }, 0, t).refresh).toBe('r1')
    expect(() => parseTokens({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 0)).toThrow(/expired or revoked/)
    expect(() => parseTokens({ access_token: 'a3' }, 0)).toThrow(/no refresh token/)
    expect(missingScopes(SCOPES[0])).toEqual([SCOPES[1]])
  })
})

describe('the loopback sign-in', () => {
  it('opens the consent page, takes the redirect on 127.0.0.1 and swaps the code with the verifier', async () => {
    const posts: { url: string; form: Record<string, string> }[] = []
    let page = ''
    const tokens = await signIn(
      { id: 'test.apps.googleusercontent.com', secret: '' },
      {
        now: () => 1000,
        // the browser: Google sends it back to the redirect with a code and the same state
        open: async (url) => {
          const u = new URL(url)
          const back = new URL(u.searchParams.get('redirect_uri') as string)
          expect(back.hostname).toBe('127.0.0.1')
          back.searchParams.set('code', 'the-code')
          back.searchParams.set('state', u.searchParams.get('state') as string)
          void fetch(back).then(async (r) => (page = await r.text()))
        },
        post: async (url, form) => {
          posts.push({ url, form })
          return { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: SCOPES.join(' ') }
        }
      }
    )
    expect(tokens).toMatchObject({ access: 'access', refresh: 'refresh' })
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(TOKEN_URL)
    expect(posts[0].form).toMatchObject({ code: 'the-code', grant_type: 'authorization_code', client_id: 'test.apps.googleusercontent.com' })
    expect(posts[0].form.code_verifier).toMatch(/^[\w-]{43,}$/)
    // a blank secret isn't sent at all
    expect('client_secret' in posts[0].form).toBe(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(page).toMatch(/connected to your YouTube channel/)
  })

  it('fails plainly when the user says no in the browser', async () => {
    await expect(
      signIn(
        { id: 'test.apps.googleusercontent.com', secret: '' },
        {
          now: () => 0,
          open: async (url) => {
            const u = new URL(url)
            const back = new URL(u.searchParams.get('redirect_uri') as string)
            back.searchParams.set('error', 'access_denied')
            void fetch(back).catch(() => {})
          },
          post: async () => ({})
        }
      )
    ).rejects.toThrow('You turned down the Google sign-in.')
  })

  it('refreshes with the refresh token', async () => {
    const forms: Record<string, string>[] = []
    const t = await refresh({ id: 'x.apps.googleusercontent.com', secret: '' }, { access: 'old', refresh: 'r', expiresAt: 0, scope: '' }, async (_u, f) => (forms.push(f), { access_token: 'new', expires_in: 3600 }), 0)
    expect(forms[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' })
    expect(t).toMatchObject({ access: 'new', refresh: 'r' })
  })
})
