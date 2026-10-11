import type { Brand, Site } from '@shared/types'
import type { LoginResult } from '@shared/vault'
import { getData } from '../store'
import { addLog, isGranted } from '../mcp/state'
import type { Turn } from '../mcp/turns'
import { loginBusy } from './guard'
import { login } from './login'

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
    "Sign the current brand in on one of its sites with the login the user saved in TrendDeck. The app opens the sign-in page and fills it itself, you never see the username, password or any code. Returns a status: logged_in, already_logged_in, needs_code (the user didn't enter their two-factor code), needs_user (captcha or something unusual, ask the user to finish in the tab), no_saved_login (ask the user to save one in Settings > Saved logins, or sign in themselves) or failed. The site has to be allowed for agents.",
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
    const status = await login(brand, site)
    await addLog({ brandId: brand.id, siteId: site.id, kind: 'login', detail: status })
    return answer(status)
  }
}
