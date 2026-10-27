import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { OBS_CHANNELS, type ObsConnectionInput } from '@shared/obs'
import { assertBrand, obsPreferences } from './preferences'
import { configureObs, obsStatus } from './service'

export { OBS_TOOLS } from './tools'

function trusted(event: IpcMainInvokeEvent, brandId: unknown): asserts brandId is string {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || event.senderFrame !== event.sender.mainFrame || event.sender.getType() !== 'window') throw new Error('OBS settings are only available to the main app window')
  assertBrand(brandId)
}

export function setupObs(): void {
  ipcMain.handle(OBS_CHANNELS.preferences, (event, brandId: unknown) => {
    trusted(event, brandId)
    return obsPreferences(brandId)
  })
  ipcMain.handle(OBS_CHANNELS.configure, (event, brandId: unknown, input: unknown) => {
    trusted(event, brandId)
    return configureObs(brandId, input as ObsConnectionInput)
  })
  ipcMain.handle(OBS_CHANNELS.status, (event, brandId: unknown) => {
    trusted(event, brandId)
    return obsStatus(brandId)
  })
}
