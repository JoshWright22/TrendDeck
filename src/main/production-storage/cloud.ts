import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import { isMediaExt } from '@shared/media'
import { ID_PATTERN } from '@shared/types'
import { resolveForUpload } from '../media/upload'
import { executable, runProcess } from './process'
import { noSymlinks, remoteDestination, StorageError } from './safety'

const PROVIDERS = new Set(['drive', 's3', 'b2', 'onedrive'])

export async function storageRemotes(root: string): Promise<{ name: string; provider: string }[]> {
  const binary = await executable('rclone')
  const output = await runProcess(binary, ['listremotes', '--long'], root, { limit: 32 * 1024 })
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):\s+(drive|s3|b2|onedrive)\s*$/.exec(line)
    return match && PROVIDERS.has(match[2]) ? [{ name: match[1], provider: match[2] }] : []
  })
}

export async function copyMedia(root: string, brandId: string, projectId: string, ids: string[], rawDestination: unknown): Promise<unknown> {
  if (!ID_PATTERN.test(brandId) || !ID_PATTERN.test(projectId)) throw new StorageError('Invalid brand or project.')
  if (!ids.length || ids.length > 100 || ids.some((id) => !ID_PATTERN.test(id))) throw new StorageError('Select between 1 and 100 media IDs.')
  const { remote, destination } = remoteDestination(rawDestination)
  if (!(await storageRemotes(root)).some((item) => item.name === remote)) throw new StorageError('Choose a configured Drive, S3, B2 or OneDrive remote from storage_remotes. Configure credentials outside chat.')
  const binary = await executable('rclone')
  const selected: { id: string; path: string; size: number; modified: number }[] = []
  for (const id of [...new Set(ids)]) {
    const file = await resolveForUpload(id, { brandId, forAgent: true })
    const path = await noSymlinks(file.path)
    const stat = await fs.stat(path)
    const name = basename(path)
    if (!stat.isFile() || stat.nlink !== 1 || !isMediaExt(extname(path).slice(1).toLowerCase()) || name.startsWith('.') || /[\x00-\x1f\x7f]/.test(name)) throw new StorageError('Only regular media files without links can be copied.')
    selected.push({ id, path, size: stat.size, modified: stat.mtimeMs })
  }
  const copied: string[] = []
  for (const file of selected) {
    try {
      const current = await resolveForUpload(file.id, { brandId, forAgent: true })
      const path = await noSymlinks(current.path)
      const stat = await fs.stat(path)
      if (path !== file.path || stat.size !== file.size || stat.mtimeMs !== file.modified || stat.nlink !== 1) throw new StorageError('Media changed during this operation; retry once it is stable.')
      await runProcess(binary, [
        'copy', '--immutable', '--no-traverse', '--retries=1', '--low-level-retries=1',
        '--contimeout=15s', '--timeout=60s', '--log-level=ERROR', '--stats=0',
        '--', path, `${destination}/${brandId}/${projectId}/${file.id}`
      ], root, { timeout: 10 * 60_000, limit: 32 * 1024 })
      copied.push(file.id)
    } catch {
      return { ok: false, copied, failed: file.id, remaining: selected.length - copied.length, note: 'Copy stopped. Earlier files may be uploaded and the failed file may be partial. No sync or deletion was requested. Check permissions, stable media and remote setup outside chat; retrying will not overwrite different existing objects.' }
    }
  }
  return { ok: true, copied, note: 'Copied selected media into brand/project/media-ID subfolders. Existing different objects are not overwritten; nothing was deleted.' }
}
