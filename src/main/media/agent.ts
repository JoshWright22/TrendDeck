// what chat agents get. ids, names and metadata only: no paths, no file contents, no browsing.
// anything an agent wants uploaded goes through the posting code, which calls resolveForUpload itself
import { filterMedia, type MediaFilter, type MediaInfo } from '@shared/media'
import { findItem, getLib, toInfo, validId } from './library'

const MAX_RESULTS = 200

// files of a brand the agent is allowed to use, missing files never show up
export async function listMedia(brandId: string, filter: MediaFilter = {}): Promise<MediaInfo[]> {
  if (!validId(brandId)) return []
  const lib = await getLib(brandId)
  const f: MediaFilter = { ...filter, agentOnly: true, includeMissing: false }
  return filterMedia(lib.items, f).slice(0, MAX_RESULTS).map(toInfo)
}

// null when it doesn't exist or the agent switch is off for it
export async function getMedia(id: string): Promise<MediaInfo | null> {
  const item = await findItem(id)
  return item && item.agentAllowed ? toInfo(item) : null
}

// agents tend to say a name, not an id. exact name first, then the only partial match
export async function findMediaByName(brandId: string, name: string): Promise<MediaInfo | null> {
  const all = await listMedia(brandId)
  const want = String(name).trim().toLowerCase()
  if (!want) return null
  const exact = all.filter((m) => m.name.toLowerCase() === want || `${m.name}.${m.ext}`.toLowerCase() === want)
  if (exact.length === 1) return exact[0]
  const part = all.filter((m) => m.name.toLowerCase().includes(want))
  return part.length === 1 ? part[0] : null
}
