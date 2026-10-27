import type { Brand, Site } from '@shared/types'
import type { LoginResult } from '@shared/vault'
import { getData } from '../store'
import { addLog, isGranted } from '../mcp/state'
import type { Turn } from '../mcp/turns'
import { loginBusy } from './guard'
import { login } from './login'
import { requestLogin } from './requests'

function findSite(brand: Brand, key: string): Site | null {
  const k = key.trim().toLowerCase()
  return brand.sites.find((s) => s.id === key || s.name.toLowerCase() === k) ?? null
}

// the agent only ever gets a status back, plus a plain note when the status alone would confuse it
function answer(status: LoginResult, note = ''): Record<string, string> {
  return note ? { status, note } : { status }
}

// login(site): the app fills the saved login itself, the agent never sees it
export const loginTool = {
  name: 'login',
  description:
    "Sign the current brand in on one of its allowed sites. If no login is saved, TrendDeck automatically displays a private sign-in form inside this chat and waits for the user. The app encrypts credentials and fills the website itself; you never receive the username, password or code. Never ask the user to paste credentials into chat. Returns logged_in, already_logged_in, needs_code, needs_user or failed. OAuth and captchas must be completed by the user on the website.",
  inputSchema: {
    type: 'object',
    properties: { site: { type: 'string', description: 'site id or name from list_brands' } },
    required: ['site'],
    additionalProperties: false
  },
  run: async (turn: Turn, args: Record<string, unknown>): Promise<unknown> => {
    const brand = getData()?.brands.find((b) => b.id === turn.brandId)
    if (!brand) return answer('failed', 'this brand was deleted')
    const site = typeof args.site === 'string' ? findSite(brand, args.site.slice(0, 100)) : null
    if (!site) return answer('failed', `${brand.name} has no site called ${String(args.site)}`)
    const allowed = turn.sharedSiteId === site.id || (await isGranted(brand.id, site.id))
    if (!allowed) {
      await addLog({ brandId: brand.id, siteId: site.id, kind: 'denied', detail: 'login' })
      return answer('needs_user', "the user hasn't let agents use this site")
    }
    if (loginBusy(brand.id)) return answer('needs_user', 'a login is already running for this brand')
    let status = await login(brand, site)
    if (status === 'no_saved_login') {
      const saved = await requestLogin(turn, site)
      if (!saved) return answer('needs_user', 'the secure sign-in request was cancelled, expired, or is already waiting')
      status = await login(brand, site)
    }
    await addLog({ brandId: brand.id, siteId: site.id, kind: 'login', detail: status })
    return answer(status)
  }
}
