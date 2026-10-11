// the one place a library id turns into a real path.
// only the app's own posting and site tab code imports this. never hand it to an agent tool
// and never put it behind ipc, the renderer doesn't need it.
import { promises as fs } from 'node:fs'
import { findItem, markPosted } from './library'

export interface UploadFile {
  path: string
  // file name with extension, for the upload form
  fileName: string
  size: number
}

export interface ResolveOpts {
  // true when an agent asked for this file, then its switch has to be on
  forAgent: boolean
  // when set the file has to be in this brand's library
  brandId?: string
}

export async function resolveForUpload(id: string, opts: ResolveOpts): Promise<UploadFile> {
  const item = await findItem(id)
  if (!item || (opts.brandId && item.brandId !== opts.brandId)) throw new Error('not in the media library')
  if (opts.forAgent && !item.agentAllowed) throw new Error('agents are not allowed to use this file')
  const st = await fs.stat(item.path).catch(() => null)
  if (!st?.isFile()) throw new Error(`${item.name} is missing, find it again in Media`)
  return { path: item.path, fileName: `${item.name}${item.ext ? `.${item.ext}` : ''}`, size: st.size }
}

// posting code calls this once a post with the file went out
export async function recordPost(id: string, platform: string, url = ''): Promise<void> {
  const item = await findItem(id)
  if (item) await markPosted(item.brandId, id, platform, url)
}
