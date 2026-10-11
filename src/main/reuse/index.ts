import { ipcMain, session } from 'electron'
import { ID_PATTERN, partitionFor } from '@shared/types'
import type { ShortsList, VideoInfo } from '@shared/reuse'
import { resolveForUpload } from '../media/upload'
import { loadPace, savePace } from './pace'
import { probeVideo } from './probe'
import { parseShorts, shortsUrl } from './shorts'

async function listShorts(brandId: string, channelUrl: string): Promise<ShortsList> {
  const res: ShortsList = { channelUrl, shorts: [], error: '' }
  try {
    const url = shortsUrl(channelUrl)
    res.channelUrl = url
    // the brand's own session, so the cookies from its youtube tab go along
    const r = await session.fromPartition(partitionFor(brandId)).fetch(url, {
      headers: { 'accept-language': 'en-US,en;q=0.9' }
    })
    if (!r.ok) throw new Error(`YouTube said ${r.status}`)
    res.shorts = parseShorts(await r.text())
    if (!res.shorts.length) res.error = 'No Shorts found on that channel'
  } catch (e) {
    res.error = e instanceof Error ? e.message : 'Reading the channel failed'
  }
  return res
}

export function setupReuse(): void {
  void loadPace()
  ipcMain.handle('reuse:pace-get', () => loadPace())
  ipcMain.handle('reuse:pace-set', (_e, pace: unknown) => savePace(pace))
  // the page only ever has a library id, the path stays in main
  ipcMain.handle('reuse:probe', async (_e, brandId: unknown, mediaId: unknown): Promise<VideoInfo> => {
    const id = typeof mediaId === 'string' ? mediaId : ''
    const empty: VideoInfo = { mediaId: id, name: '', bytes: 0, seconds: 0, width: 0, height: 0, error: '' }
    if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId) || !id) return { ...empty, error: 'Unknown file' }
    try {
      const file = await resolveForUpload(id, { forAgent: false, brandId })
      return await probeVideo(file.path, id, file.fileName)
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('reuse:shorts', (_e, brandId: unknown, channelUrl: unknown) => {
    if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) {
      return { channelUrl: '', shorts: [], error: 'Unknown brand' }
    }
    return listShorts(brandId, typeof channelUrl === 'string' ? channelUrl : '')
  })
}
