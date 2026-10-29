// the agent has a shell like any claude code, but TrendDeck's own folder (logins, keys, cookies)
// stays out of reach: a command that names it, other than the agent's own room, or that goes for
// windows' secret store, doesn't run. file tools are kept out by claude code's own rules
// (privateRules in claude.ts), this covers the shell, in every mode, full access too

const sep = String.raw`[\\/]+`

// every way a command can spell the folder: the real path in either slash and as /c/..., and
// through the APPDATA variable in cmd, powershell and bash
function folderPatterns(dir: string): RegExp[] {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  const drive = /^([A-Za-z]):$/.exec(parts[0] ?? '')
  const rest = (drive ? parts.slice(1) : parts).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(sep)
  const name = parts[parts.length - 1]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? 'TrendDeck'
  const after = String.raw`(?!${sep}agent-room(?![\w-]))`
  const out = [new RegExp(`${drive ? `(?:${drive[1]}:|${sep}${drive[1]})${sep}` : sep}${rest}${after}`, 'i')]
  out.push(new RegExp(String.raw`(?:%APPDATA%|\$env:APPDATA|\$\{?APPDATA\}?|\[Environment\]::GetFolderPath\([^)]*\))${sep}${name}${after}`, 'i'))
  out.push(new RegExp(String.raw`Roaming${sep}${name}${after}`, 'i'))
  return out
}

// windows' secret store: what electron's safeStorage keeps the logins encrypted with
const SECRET_STORE = /CryptUnprotectData|ProtectedData|\bDPAPI\b|Unprotect-|safeStorage|os_crypt|Local State/i

export function touchesPrivate(command: string, dir: string): boolean {
  if (SECRET_STORE.test(command)) return true
  return folderPatterns(dir).some((r) => r.test(command))
}

export const PRIVATE_REASON =
  "That command reaches into TrendDeck's own folder, where the user's logins and keys are kept, so it doesn't run. Your own room (agent-room) is fine. For signed-in work use TrendDeck's tools, which do it without handing you the login."
