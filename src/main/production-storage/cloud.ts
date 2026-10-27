import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isMediaExt } from '@shared/media'
import { ID_PATTERN } from '@shared/types'
import { resolveForUpload } from '../media/upload'
import { executable, runProcess } from './process'
import { noSymlinks, remoteDestination, StorageError } from './safety'
import { parseRemotes, type Remote } from './remotes'

export async function storageRemotes(root: string): Promise<Remote[]> {
  const binary = await executable('rclone')
  const output = await runProcess(binary, ['listremotes', '--long'], root, { limit: 32 * 1024 })
  return parseRemotes(output)
}

export interface CopyProgress {
  total: number
  copied: number
  verified: number
  archived: number
}

export interface CopyOptions {
  // after a copy checks out against the cloud, the local original goes to the recycle bin
  archive?: boolean
  onProgress?: (p: CopyProgress) => void
}

// the cloud copy has the same content as the local file. rclone compares hashes when both sides
// have one in common, sizes otherwise. a list file keeps odd names from being read as filters
async function verifyCopy(binary: string, root: string, path: string, remoteDir: string): Promise<boolean> {
  const list = join(tmpdir(), `trenddeck-check-${randomUUID()}.txt`)
  try {
    await fs.writeFile(list, `${basename(path)}\n`, 'utf8')
    await runProcess(binary, ['check', '--one-way', '--files-from-raw', list, '--log-level=ERROR', '--', dirname(path), remoteDir], root, {
      timeout: 10 * 60_000,
      limit: 32 * 1024
    })
    return true
  } catch {
    return false
  } finally {
    await fs.unlink(list).catch(() => {})
  }
}

export async function copyMedia(
  root: string,
  brandId: string,
  projectId: string,
  ids: string[],
  rawDestination: unknown,
  opts: CopyOptions = {}
): Promise<{ ok: boolean; copied: string[]; verified: string[]; archived: string[]; failed?: string; note: string }> {
  if (!ID_PATTERN.test(brandId) || !ID_PATTERN.test(projectId)) throw new StorageError('Invalid brand or project.')
  if (!ids.length || ids.length > 100 || ids.some((id) => !ID_PATTERN.test(id))) throw new StorageError('Select between 1 and 100 media IDs.')
  const { remote, destination } = remoteDestination(rawDestination)
  if (!(await storageRemotes(root)).some((item) => item.name === remote)) {
    throw new StorageError('Choose a configured Drive, Dropbox, OneDrive, S3, R2 or B2 remote from storage_remotes. Set them up in Settings, Storage.')
  }
  const binary = await executable('rclone')
  const selected: { id: string; path: string; size: number; modified: number }[] = []
  for (const id of [...new Set(ids)]) {
    const file = await resolveForUpload(id, { brandId, forAgent: true })
    const path = await noSymlinks(file.path)
    const stat = await fs.stat(path)
    const name = basename(path)
    if (!stat.isFile() || stat.nlink !== 1 || !isMediaExt(extname(path).slice(1).toLowerCase()) || name.startsWith('.') || /[\x00-\x1f\x7f]/.test(name)) {
      throw new StorageError('Only regular media files without links can be copied.')
    }
    selected.push({ id, path, size: stat.size, modified: stat.mtimeMs })
  }
  const copied: string[] = []
  const verified: string[] = []
  const archived: string[] = []
  const tell = (): void => opts.onProgress?.({ total: selected.length, copied: copied.length, verified: verified.length, archived: archived.length })
  tell()
  for (const file of selected) {
    const remoteDir = `${destination}/${brandId}/${projectId}/${file.id}`
    try {
      const current = await resolveForUpload(file.id, { brandId, forAgent: true })
      const path = await noSymlinks(current.path)
      const stat = await fs.stat(path)
      if (path !== file.path || stat.size !== file.size || stat.mtimeMs !== file.modified || stat.nlink !== 1) {
        throw new StorageError('Media changed during this operation; retry once it is stable.')
      }
      await runProcess(binary, [
        'copy', '--immutable', '--no-traverse', '--retries=1', '--low-level-retries=1',
        '--contimeout=15s', '--timeout=60s', '--log-level=ERROR', '--stats=0',
        '--', path, remoteDir
      ], root, { timeout: 60 * 60_000, limit: 32 * 1024 })
      copied.push(file.id)
      tell()
      if (await verifyCopy(binary, root, path, remoteDir)) {
        verified.push(file.id)
        tell()
        if (opts.archive) {
          await shell.trashItem(path)
          archived.push(file.id)
          tell()
        }
      }
    } catch {
      return {
        ok: false,
        copied,
        verified,
        archived,
        failed: file.id,
        note: 'Copy stopped. Earlier files may be uploaded and the failed file may be partial. Nothing was deleted from the cloud. Check the remote in Settings, Storage; retrying will not overwrite different existing objects.'
      }
    }
  }
  const unverified = copied.length - verified.length
  const parts = [`Copied ${copied.length} file${copied.length === 1 ? '' : 's'} into brand/project/media-ID folders.`]
  if (verified.length) parts.push(`Checked ${verified.length} against the cloud copy.`)
  if (unverified) parts.push(`${unverified} could not be checked, so the originals stay where they are.`)
  if (archived.length) parts.push(`Moved ${archived.length} original${archived.length === 1 ? '' : 's'} to the Recycle Bin.`)
  else parts.push('Originals stay on this computer.')
  return { ok: true, copied, verified, archived, note: parts.join(' ') }
}
