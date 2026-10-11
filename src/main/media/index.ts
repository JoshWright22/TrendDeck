import { BrowserWindow, dialog, ipcMain, shell, webContents, type IpcMainInvokeEvent } from 'electron'
import { filterMedia, type MediaEdit, type MediaFilter, type MediaProbe } from '@shared/media'
import {
  addFiles,
  checkMissing,
  copyItemsIn,
  dropLib,
  editItems,
  getLib,
  loadAllLibs,
  markPosted,
  onLibraryChange,
  publicLib,
  purge,
  relinkItem,
  removeItems,
  setCollections,
  setCopyByDefault,
  setProbe,
  toInfo,
  undoRemove,
  unmarkPosted,
  validId
} from './library'
import { handleMediaScheme, registerMediaScheme } from './protocol'
import { addWatch, editWatch, removeWatch, startAllWatches, stopBrandWatches } from './watch'

export { listMedia, getMedia, findMediaByName } from './agent'

registerMediaScheme()

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(validId).slice(0, 5000) : []
}

function check(event: IpcMainInvokeEvent, brandId: unknown): brandId is string {
  return event.sender.getType() === 'window' && validId(brandId)
}

// every call names a brand, refuse anything that doesn't look like one
function handle(channel: string, fn: (brandId: string, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, brandId: unknown, ...args: unknown[]) => {
    if (!check(event, brandId)) throw new Error('bad media call')
    return fn(brandId, ...args)
  })
}

// same, for calls that open a dialog on the window that asked
function handleWin(
  channel: string,
  fn: (w: BrowserWindow | null, brandId: string, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, async (event, brandId: unknown, ...args: unknown[]) => {
    if (!check(event, brandId)) throw new Error('bad media call')
    return fn(BrowserWindow.fromWebContents(event.sender), brandId, ...args)
  })
}

export function setupMedia(): void {
  onLibraryChange((brandId) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'window' && !wc.isDestroyed()) wc.send('media:changed', brandId)
    }
  })

  handle('media:library', async (brandId) => {
    await checkMissing(brandId)
    return publicLib(await getLib(brandId))
  })
  handle('media:list', async (brandId, filter) => {
    const lib = await getLib(brandId)
    return filterMedia(lib.items, (filter ?? {}) as MediaFilter).map(toInfo)
  })
  handleWin('media:pick-add', async (w, brandId, folders) => {
    const opts: Electron.OpenDialogOptions = {
      title: folders ? 'Add a folder to Media' : 'Add files to Media',
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return { added: 0, skipped: 0, ids: [] }
    return addFiles(brandId, res.filePaths)
  })
  handle('media:add-paths', (brandId, paths) =>
    addFiles(brandId, Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [])
  )
  handle('media:edit', (brandId, list, edit) => editItems(brandId, ids(list), (edit ?? {}) as MediaEdit))
  handle('media:remove', (brandId, list) => removeItems(brandId, ids(list)))
  handle('media:undo-remove', (brandId, list) => undoRemove(brandId, ids(list)))
  handle('media:copy-in', (brandId, list) => copyItemsIn(brandId, ids(list)))
  handleWin('media:relink', async (w, brandId, id) => {
    if (!validId(id)) return false
    const opts: Electron.OpenDialogOptions = { title: 'Find the file', properties: ['openFile'] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return false
    return relinkItem(brandId, id, res.filePaths[0])
  })
  handle('media:reveal', async (brandId, id) => {
    const item = (await getLib(brandId)).items.find((i) => i.id === id)
    if (item && !item.missing) shell.showItemInFolder(item.path)
  })
  handle('media:mark-posted', (brandId, id, platform, url) =>
    validId(id) ? markPosted(brandId, id, String(platform), String(url ?? '')) : undefined
  )
  handle('media:unmark-posted', (brandId, id, platform, at) =>
    validId(id) ? unmarkPosted(brandId, id, String(platform), Number(at)) : undefined
  )
  handle('media:probe', (brandId, id, probe) =>
    validId(id) ? setProbe(brandId, id, (probe ?? {}) as MediaProbe) : undefined
  )
  handle('media:collections', (brandId, list) =>
    setCollections(brandId, Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [])
  )
  handle('media:copy-default', (brandId, on) => setCopyByDefault(brandId, on === true))
  handleWin('media:watch-add', async (w, brandId) => {
    const opts: Electron.OpenDialogOptions = { title: 'Watch a folder', properties: ['openDirectory'] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (!res.canceled && res.filePaths[0]) await addWatch(brandId, res.filePaths[0])
  })
  handle('media:watch-edit', (brandId, watchId, on) =>
    validId(watchId) ? editWatch(brandId, watchId, on === true) : undefined
  )
  handle('media:watch-remove', (brandId, watchId) =>
    validId(watchId) ? removeWatch(brandId, watchId) : undefined
  )

  handleMediaScheme()
  void startAllWatches()
  // clear out anything left in the trash from last time
  void loadAllLibs().then((libs) => libs.forEach((l) => void purge(l.brandId)))
}

export async function dropMedia(brandId: string): Promise<void> {
  stopBrandWatches(brandId)
  await dropLib(brandId)
}
