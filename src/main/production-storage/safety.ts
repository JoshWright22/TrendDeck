import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep, extname, parse, join } from 'node:path'

export class StorageError extends Error {}
export const MAX_METADATA_BYTES = 512 * 1024
export const IGNORE_POLICY = `# TrendDeck: metadata only; never media or credentials
*
!*/
!*.md
!*.txt
!*.json
!*.yaml
!*.yml
!*.toml
!*.srt
!*.vtt
.*
!.gitignore
**/.*/
**/node_modules/
**/recordings/
**/footage/
**/media/
**/exports/
**/credentials*
**/*secret*
**/*token*
**/*password*
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/.env*
`

export function metadataPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-zA-Z0-9_. /-]+$/.test(value)) throw new StorageError('Use a plain project-relative metadata file name.')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.startsWith('-'))) throw new StorageError('Unsafe metadata path.')
  if (parts.some((part) => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new StorageError('Reserved file name.')
  if (value !== '.gitignore' && (parts.some((part) => part.startsWith('.')) || !['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.srt', '.vtt'].includes(extname(value).toLowerCase()))) throw new StorageError('Only plain text project metadata can be versioned; media and hidden files are excluded.')
  if (/(?:credential|secret|token|password|private[ _-]?key|cookies?|session|oauth|vault|rclone|recording|footage|(?:^|\/)media(?:\/|$)|(?:^|\/)exports?(?:\/|$)|node_modules)/i.test(value)) throw new StorageError('Sensitive files and media folders cannot be versioned.')
  return value
}

export function safeText(bytes: Buffer): string {
  if (bytes.length > MAX_METADATA_BYTES || bytes.includes(0)) throw new StorageError('Metadata must be small plain text, not binary media.')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new StorageError('Metadata must be UTF-8 plain text.')
  if (/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:password|passwd|secret|token|api[_ -]?key|authorization|client[_ -]?secret|access[_ -]?key|credential|cookie)["']?\s*[:=]\s*[^\s,}]{2,}|[a-z][a-z0-9+.-]*:\/\/[^\s/]+:[^\s/]+@/i.test(text)) throw new StorageError('Possible credentials found. Remove secrets before Git; detection is conservative, not a guarantee.')
  return text
}

export async function noSymlinks(path: string): Promise<string> {
  const full = resolve(path)
  let current = parse(full).root
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    if ((await fs.lstat(current)).isSymbolicLink()) throw new StorageError('Symbolic links and junctions are not allowed.')
  }
  const real = await fs.realpath(full)
  if ((process.platform === 'win32' ? real.toLowerCase() !== full.toLowerCase() : real !== full)) throw new StorageError('Path resolves outside its expected location.')
  return full
}

export async function metadataFile(root: string, name: string): Promise<Buffer> {
  metadataPath(name)
  const full = resolve(root, name)
  const inside = relative(root, full)
  if (!inside || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new StorageError('Path escapes the project.')
  await noSymlinks(full)
  const handle = await fs.open(full, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_METADATA_BYTES) throw new StorageError('Only small, regular metadata files without hard links are allowed.')
    const bytes = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const content = bytes.subarray(0, bytesRead)
    safeText(content)
    return content
  } finally {
    await handle.close()
  }
}

export function remoteDestination(value: unknown): { remote: string; destination: string } {
  if (typeof value !== 'string' || value.length > 300) throw new StorageError('Choose a configured rclone remote and folder, for example archive:Brand/Project.')
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):([A-Za-z0-9_ ./-]+)$/.exec(value)
  if (!match || match[2].split('/').some((part) => !part || part.startsWith('.') || part.startsWith('-') || part.endsWith('.') || part.endsWith(' '))) throw new StorageError('Use remote:folder/subfolder without URLs, credentials, absolute paths or traversal.')
  return { remote: match[1], destination: value }
}
