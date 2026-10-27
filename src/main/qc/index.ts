import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { runQc } from './run'

export { qcTools } from './tools'
export { projectVideos, runQc, setQcFolder } from './run'

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

export function setupQc(): void {
  ipcMain.handle('qc:run', (e, brandId: unknown, projectId: unknown, file: unknown, opts: unknown) => {
    if (!fromApp(e) || typeof brandId !== 'string' || typeof projectId !== 'string' || typeof file !== 'string') {
      throw new Error('bad qc call')
    }
    return runQc(brandId, projectId, file, opts)
  })
}
