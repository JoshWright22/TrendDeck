import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ID_PATTERN } from '@shared/types'
import type { ContextState } from '@shared/context'
import { addRule, editRule, removeRule, styleBlock } from './rules'
import { changeContext, changed, contextState, dropBrandFiles, loadContext, reindexDocs, type ContextFile } from './store'

// context inputs for the chat agent per brand: brand docs, past video transcripts and style rules.
// the agent reads them with CONTEXT_TOOLS, the rules also go into every turn through styleContext

export { CONTEXT_TOOLS } from './tools'
export { styleBlock } from './rules'

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

function brandIdOf(e: IpcMainInvokeEvent, v: unknown): string {
  if (!fromApp(e)) throw new Error('bad context call')
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) throw new Error('bad brand id')
  return v
}

// the style rules block for the agent's context, '' when there are none
export async function styleContext(brandId: string): Promise<string> {
  if (!ID_PATTERN.test(brandId)) return ''
  try {
    return styleBlock((await loadContext(brandId)).rules)
  } catch {
    return ''
  }
}

async function setFolder(brandId: string, folder: string | null): Promise<ContextState> {
  await changeContext(brandId, (f) => ({ file: { ...f, docsFolder: folder }, out: null }))
  void reindexDocs(brandId)
  changed(brandId)
  return contextState(brandId)
}

async function ruleChange(brandId: string, fn: (f: ContextFile) => { file: ContextFile; out: string | null }): Promise<string | null> {
  const error = await changeContext(brandId, fn)
  if (!error) changed(brandId)
  return error
}

export function setupContext(): void {
  ipcMain.handle('context:get', (e, brandId: unknown) => contextState(brandIdOf(e, brandId)))
  ipcMain.handle('context:pick-folder', async (e, brandId: unknown) => {
    const id = brandIdOf(e, brandId)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(e.sender)
    const current = (await loadContext(id)).docsFolder
    const opts: Electron.OpenDialogOptions = {
      title: 'Pick your brand docs folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory'],
      ...(current ? { defaultPath: current } : {})
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const folder = picked.filePaths[0]
    if (picked.canceled || !folder) return contextState(id)
    return setFolder(id, folder)
  })
  ipcMain.handle('context:clear-folder', (e, brandId: unknown) => setFolder(brandIdOf(e, brandId), null))
  ipcMain.handle('context:reindex', async (e, brandId: unknown) => {
    const id = brandIdOf(e, brandId)
    void reindexDocs(id)
    return contextState(id)
  })
  ipcMain.handle('context:rule-add', (e, brandId: unknown, text: unknown) =>
    ruleChange(brandIdOf(e, brandId), (f) => {
      const r = addRule(f.rules, text, 'user')
      return r.ok ? { file: { ...f, rules: r.rules }, out: null } : { file: f, out: r.error }
    })
  )
  ipcMain.handle('context:rule-edit', (e, brandId: unknown, id: unknown, text: unknown) =>
    ruleChange(brandIdOf(e, brandId), (f) => {
      const r = editRule(f.rules, typeof id === 'string' ? id : '', text)
      return r.ok ? { file: { ...f, rules: r.rules }, out: null } : { file: f, out: r.error }
    })
  )
  ipcMain.handle('context:rule-remove', async (e, brandId: unknown, id: unknown) => {
    await ruleChange(brandIdOf(e, brandId), (f) => ({ file: { ...f, rules: removeRule(f.rules, typeof id === 'string' ? id : '') }, out: null }))
  })
}

// a deleted brand's context files go with it
export async function dropContextBrand(brandId: string): Promise<void> {
  await dropBrandFiles(brandId)
}
