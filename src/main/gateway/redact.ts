// scrubs anything secret shaped out of what goes back to an agent. the tools already never
// hand out keys, passwords or cookies, this is the second lock in case one slips through.
// pure, no electron, so scripts/gateway-test.ts can run it on its own

export const REDACTED = '[redacted]'

// key names whose values never go out, matched anywhere in the name
const SECRET_KEY_PART =
  /pass(word|wd|phrase)|secret|token|cookie|authori[sz]ation|api[-_]?key|apikey|credential|private[-_]?key|session[-_]?id|sessionid|bearer|csrf|xsrf|refresh[-_]?token|otp[-_]?code|2fa[-_]?code|mfa[-_]?code/i
// short names that are only secret on their own
const SECRET_KEY_EXACT = /^(key|keys|auth|pwd|pin|otp|totp|sid|sig|signature|cookies?|set-cookie|headers?)$/i

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PART.test(key) || SECRET_KEY_EXACT.test(key)
}

// [pattern, replacement]. order matters a little: headers before bare tokens
const RULES: [RegExp, string][] = [
  // pem private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // http headers written out as text
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1 ${REDACTED}`],
  // jwt
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
  // well known key shapes: openai/anthropic, aws, github, slack, google, google oauth, meta
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\b1\/\/[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bEAA[A-Za-z0-9]{30,}/g, REDACTED],
  // secrets in a url query or fragment
  [
    /([?&#](?:access_token|refresh_token|id_token|token|auth|api_key|apikey|key|client_secret|password|pass|sig|signature|session|sessionid|code)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`
  ],
  // password=..., api_key: "...", and so on in plain text
  [
    /\b(password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token)(\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi,
    `$1$2${REDACTED}`
  ],
  // long hex like the per turn tokens. uuids have dashes and stay
  [/\b[a-f0-9]{40,}\b/gi, REDACTED]
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// known values from the vault, posting keys, analytics tokens and open turns
export function redactText(text: string, known: readonly string[] = []): string {
  let out = text
  for (const v of known) {
    if (!v || v.length < 4) continue
    const forms = new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)])
    for (const f of forms) out = out.replace(new RegExp(escape(f), 'g'), REDACTED)
  }
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

// deep copy with secret keys blanked and every string scrubbed. booleans and null stay so
// things like hasPassword: true still read right
export function redact<T>(value: T, known: readonly string[] = [], depth = 0): T {
  if (depth > 20) return REDACTED as unknown as T
  if (typeof value === 'string') return redactText(value, known) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redact(v, known, depth + 1)) as unknown as T
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k) && v !== null && v !== undefined && typeof v !== 'boolean') {
        // an empty secret is still empty, the agent can tell nothing is saved
        out[k] = v === '' ? '' : REDACTED
      } else {
        out[k] = redact(v, known, depth + 1)
      }
    }
    return out as T
  }
  return value
}
