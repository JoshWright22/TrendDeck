import type { Session } from 'electron'
import { hostOf, type Site } from '@shared/types'
import type { Health, SiteHealth } from '@shared/inbox'

// the cookie each site only sets once you're logged in. the check reads cookies from the
// brand's session and never loads a page, so it's quick and can't log anything out
const LOGIN_COOKIES: { match: (host: string) => boolean; domain: string; names: string[] }[] = [
  { match: (h) => h.endsWith('youtube.com'), domain: 'youtube.com', names: ['LOGIN_INFO', 'SAPISID', '__Secure-3PAPISID'] },
  { match: (h) => h.endsWith('google.com'), domain: 'google.com', names: ['SAPISID', 'SID'] },
  { match: (h) => h.endsWith('instagram.com'), domain: 'instagram.com', names: ['sessionid'] },
  { match: (h) => h.endsWith('tiktok.com'), domain: 'tiktok.com', names: ['sessionid', 'sid_tt'] },
  { match: (h) => h === 'x.com' || h.endsWith('.x.com'), domain: 'x.com', names: ['auth_token'] },
  { match: (h) => h.endsWith('twitter.com'), domain: 'twitter.com', names: ['auth_token'] },
  { match: (h) => h.endsWith('reddit.com'), domain: 'reddit.com', names: ['reddit_session'] },
  { match: (h) => h.endsWith('facebook.com'), domain: 'facebook.com', names: ['c_user'] },
  { match: (h) => h.endsWith('threads.net') || h.endsWith('threads.com'), domain: 'threads.net', names: ['sessionid'] },
  { match: (h) => h.endsWith('linkedin.com'), domain: 'linkedin.com', names: ['li_at'] },
  { match: (h) => h.endsWith('pinterest.com'), domain: 'pinterest.com', names: ['_pinterest_sess', '_auth'] },
  { match: (h) => h.endsWith('twitch.tv'), domain: 'twitch.tv', names: ['auth-token'] },
  { match: (h) => h.endsWith('bsky.app'), domain: 'bsky.app', names: [] }
]

export function knowsHost(host: string): boolean {
  return LOGIN_COOKIES.some((r) => r.match(host) && r.names.length > 0)
}

export async function checkHost(ses: Session, host: string): Promise<Health> {
  const rule = LOGIN_COOKIES.find((r) => r.match(host))
  if (!rule || rule.names.length === 0) return 'unknown'
  const cookies = await ses.cookies.get({ domain: rule.domain })
  const now = Date.now() / 1000
  const live = cookies.some(
    (c) => rule.names.includes(c.name) && c.value && c.value !== '0' && (!c.expirationDate || c.expirationDate > now)
  )
  return live ? 'in' : 'out'
}

export async function checkSites(ses: Session, sites: Site[]): Promise<Record<string, SiteHealth>> {
  const out: Record<string, SiteHealth> = {}
  for (const s of sites) {
    const host = hostOf(s.url)
    out[s.id] = { siteId: s.id, host, state: host ? await checkHost(ses, host) : 'unknown', checkedAt: Date.now() }
  }
  return out
}
