// cloud remotes through rclone: which kinds TrendDeck works with, reading `rclone listremotes`
// and the arguments for `rclone config create`. pure, no electron, unit tested in remotes.test.ts

export const REMOTE_KINDS = ['drive', 'dropbox', 'onedrive', 's3', 'r2', 'b2'] as const
export type RemoteKind = (typeof REMOTE_KINDS)[number]

export const REMOTE_NAMES: Record<RemoteKind, string> = {
  drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  s3: 'Amazon S3',
  r2: 'Cloudflare R2',
  b2: 'Backblaze B2'
}

// rclone's backend for each kind. R2 is s3 with Cloudflare's endpoint
const BACKEND: Record<RemoteKind, string> = { drive: 'drive', dropbox: 'dropbox', onedrive: 'onedrive', s3: 's3', r2: 's3', b2: 'b2' }
const BACKENDS = new Set(Object.values(BACKEND))

// the ones that sign in in the browser, the rest take keys
export const OAUTH_KINDS: readonly RemoteKind[] = ['drive', 'dropbox', 'onedrive']

export interface Remote {
  name: string
  // rclone's backend type
  provider: string
}

export const REMOTE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function parseRemotes(output: string): Remote[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,63}):\s+([a-z0-9]+)\s*$/.exec(line.trim())
    return m && BACKENDS.has(m[2]) ? [{ name: m[1], provider: m[2] }] : []
  })
}

export interface RemoteInput {
  kind: RemoteKind
  name: string
  // keys for s3, r2 and b2. never stored by TrendDeck, rclone keeps them in its own config
  accessKeyId?: string
  secretAccessKey?: string
  region?: string
  // r2 only
  accountId?: string
}

export class RemoteInputError extends Error {}

const plain = (v: unknown, what: string, re: RegExp): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || !re.test(s)) throw new RemoteInputError(`Check the ${what}.`)
  return s
}

// the args after `rclone`. the secret ones are also returned so errors can be scrubbed of them
export function createArgs(raw: unknown): { args: string[]; secrets: string[]; kind: RemoteKind; name: string } {
  const r = (raw ?? {}) as Partial<RemoteInput>
  if (!REMOTE_KINDS.includes(r.kind as RemoteKind)) throw new RemoteInputError('Pick a kind of storage.')
  const kind = r.kind as RemoteKind
  const name = plain(r.name, 'name, use letters, numbers, dashes and underscores', REMOTE_NAME)
  const head = ['config', 'create', name, BACKEND[kind]]
  const tail = ['--non-interactive', '--log-level=ERROR']
  if (kind === 'drive') return { args: [...head, 'scope=drive.file', ...tail], secrets: [], kind, name }
  if (kind === 'dropbox' || kind === 'onedrive') return { args: [...head, ...tail], secrets: [], kind, name }
  const id = plain(r.accessKeyId, 'key id', /^[A-Za-z0-9+/=_-]{4,200}$/)
  const secret = plain(r.secretAccessKey, 'secret key', /^[\x21-\x7e]{4,400}$/)
  if (kind === 'b2') return { args: [...head, `account=${id}`, `key=${secret}`, ...tail], secrets: [id, secret], kind, name }
  if (kind === 'r2') {
    const account = plain(r.accountId, 'Cloudflare account id', /^[a-f0-9]{32}$/i)
    return {
      args: [...head, 'provider=Cloudflare', `access_key_id=${id}`, `secret_access_key=${secret}`, `endpoint=https://${account}.r2.cloudflarestorage.com`, 'acl=private', 'no_check_bucket=true', ...tail],
      secrets: [id, secret],
      kind,
      name
    }
  }
  const region = r.region?.trim() ? plain(r.region, 'region', /^[a-z]{2}(-[a-z]+)+-\d$/) : 'us-east-1'
  return { args: [...head, 'provider=AWS', `access_key_id=${id}`, `secret_access_key=${secret}`, `region=${region}`, ...tail], secrets: [id, secret], kind, name }
}

// the kind to show for a remote: what TrendDeck set it up as, else its backend
export function remoteKind(r: Remote, labels: Record<string, string>): RemoteKind | null {
  const l = labels[r.name]
  if (l && REMOTE_KINDS.includes(l as RemoteKind) && BACKEND[l as RemoteKind] === r.provider) return l as RemoteKind
  return REMOTE_KINDS.includes(r.provider as RemoteKind) ? (r.provider as RemoteKind) : null
}
