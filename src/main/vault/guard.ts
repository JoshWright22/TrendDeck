import type { WebContents } from 'electron'

// same isolated world as the agent tools, the page can't see any of this
const WORLD_ID = 1717

// paths that are part of signing in, signing up or account recovery
const AUTH_PATH =
  /log-?in|sign-?in|sign-?up|register|password|passwd|forgot|reset|recover|2fa|two-?factor|mfa|otp|verif|challenge|checkpoint|oauth|\/auth\b|\/sso\b|\/flow\//i
const AUTH_HOST = /^(accounts|login|signin|auth|sso|id)\./i

export function isAuthUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return AUTH_HOST.test(u.hostname) || AUTH_PATH.test(u.pathname + u.hash)
  } catch {
    return false
  }
}

// brands with a login running right now, agents get nothing from their tab until it's done
const busy = new Set<string>()

export function setLoginBusy(brandId: string, on: boolean): void {
  if (on) busy.add(brandId)
  else busy.delete(brandId)
}

export function loginBusy(brandId: string): boolean {
  return busy.has(brandId)
}

// finds the login fields and keeps them on window.__tdLogin for the filler.
// shared by the guard and the filler so they always agree on what a login page is
export const PROBE = `(() => {
  const shown = (el) => {
    if (!el.isConnected || el.disabled) return false
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    return typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : getComputedStyle(el).visibility !== 'hidden'
  }
  const hint = (el) => [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'),
    el.getAttribute('aria-label'), el.getAttribute('data-testid'),
    el.labels && el.labels[0] ? el.labels[0].innerText : ''].join(' ').toLowerCase()
  const inputs = [...document.querySelectorAll('input')].filter(shown)
  const texty = (el) => ['text', 'email', 'tel', 'number', ''].includes(el.type)
  const codeLike = (el) => texty(el) && (
    /one-time-code/.test(el.getAttribute('autocomplete') || '') ||
    /otp|one.?time|2fa|two.?factor|verification|verify|security.?code|auth.?code|mfa|totp|passcode|\\bcode\\b|\\bpin\\b/.test(hint(el)))
  const passwords = inputs.filter((el) => el.type === 'password')
  let code = inputs.filter(codeLike)
  // split code boxes, one character each
  const boxes = inputs.filter((el) => texty(el) && el.maxLength === 1)
  if (code.length === 0 && boxes.length >= 4 && boxes.length <= 8) code = boxes
  const userLike = (el) => texty(el) && !codeLike(el) && el.type !== 'number' &&
    !/search|query/.test(hint(el)) &&
    (/username|email|e-mail|login|user|phone|account|identifier|handle|mobile/.test(hint(el)) || el.type === 'email')
  let user = inputs.filter(userLike)[0] || null
  // a lone text box next to a password box is the username even with no name on it
  if (!user && passwords.length) {
    const form = passwords[0].form
    const others = inputs.filter((el) => texty(el) && !codeLike(el) && (!form || el.form === form))
    if (others.length === 1) user = others[0]
  }
  const pass = passwords.find((el) => !/new-password/.test(el.getAttribute('autocomplete') || '')) || passwords[0] || null
  const frames = [...document.querySelectorAll('iframe')].filter((f) =>
    /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare|arkoselabs|funcaptcha|captcha/i.test(f.src || f.title || '') &&
    !f.closest('.grecaptcha-badge') && shown(f) && f.getBoundingClientRect().width >= 60)
  const boxesCaptcha = [...document.querySelectorAll('.g-recaptcha,.h-captcha,.cf-turnstile,#captcha,[id*=captcha i]')]
    .filter((el) => !el.closest('.grecaptcha-badge') && shown(el))
  const alert = [...document.querySelectorAll('[role=alert],[aria-live=assertive],.error,.errors,[class*=error i]')]
    .some((el) => shown(el) && (el.innerText || '').trim().length > 3)
  window.__tdLogin = { user, pass, code }
  return {
    url: location.href,
    user: !!user,
    pass: !!pass,
    passCount: passwords.length,
    code: code.length,
    captcha: frames.length + boxesCaptcha.length > 0,
    alert
  }
})()`

export interface Probe {
  url: string
  user: boolean
  pass: boolean
  passCount: number
  code: number
  captcha: boolean
  alert: boolean
}

export async function probe(wc: WebContents): Promise<Probe | null> {
  if (wc.isDestroyed()) return null
  try {
    return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: PROBE }])) as Probe
  } catch {
    return null
  }
}

// what agent tools get instead of the page, or null when the tab is fine to use
export async function authGuard(brandId: string, wc: WebContents): Promise<string | null> {
  if (loginBusy(brandId)) return 'status: login_running. the app is signing in on this tab, wait for login to finish'
  const p = await probe(wc)
  const sensitive = isAuthUrl(wc.getURL()) || !p || p.pass || p.code > 0
  if (!sensitive) return null
  return "status: sign_in_page. this tab is on a sign-in, sign-up, password or two-factor page, so reading and acting on it is off. use login with the site, or ask the user to sign in"
}
