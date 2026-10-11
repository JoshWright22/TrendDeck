import { ipcMain, session } from 'electron'
import { ID_PATTERN, partitionFor } from '@shared/types'
import type { ShortsList } from '@shared/reuse'
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
  ipcMain.handle('reuse:probe', (_e, path: unknown) =>
    probeVideo(typeof path === 'string' ? path : '')
  )
  ipcMain.handle('reuse:shorts', (_e, brandId: unknown, channelUrl: unknown) => {
    if (typeof brandId !== 'string' || !ID_PATTERN.test(brandId)) {
      return { channelUrl: '', shorts: [], error: 'Unknown brand' }
    }
    return listShorts(brandId, typeof channelUrl === 'string' ? channelUrl : '')
  })
}
