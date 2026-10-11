import { baseDomain, hostOf, type Site } from '@shared/types'

// the tab a link belongs in: same host first, then same domain (youtube.com links go to
// the youtube tab, not youtube studio, because the bare domain wins a tie)
export function pickSite(sites: Site[], url: string): Site | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  const exact = sites.find((s) => hostOf(s.url) === host)
  if (exact) return exact
  const base = baseDomain(host)
  const same = sites.filter((s) => baseDomain(hostOf(s.url)) === base)
  return same.find((s) => hostOf(s.url) === base) ?? same[0]
}
