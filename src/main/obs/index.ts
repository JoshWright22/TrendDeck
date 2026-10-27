import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ObsCard } from '@shared/cards'
import { OBS_CHANNELS, type ObsConnectionInput } from '@shared/obs'
import { ID_PATTERN } from '@shared/types'
import { addCard, newCardId } from '../cards/store'
import { findProject } from '../craft/paths'
import { assertBrand, obsPreferences, saveRecordingSettings } from './preferences'
import {
  configureObs, liveState, obsScenes, obsStatus, previewFrame, recentTakes, startRecording, stopRecording, switchScene, unwatch, unwatchAll, watch
} from './service'

export { OBS_TOOLS } from './tools'

// only the app window's own page, never a site tab or a frame inside it
function trusted(event: IpcMainInvokeEvent, brandId: unknown): asserts brandId is string {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || event.senderFrame !== event.sender.mainFrame || event.sender.getType() !== 'window') throw new Error('OBS settings are only available to the main app window')
  assertBrand(brandId)
}

function project(brandId: string, projectId: unknown): string {
  if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) throw new Error('No project with that id')
  findProject(brandId, projectId)
  return projectId
}

const thread = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null)
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v || v.length > 200) throw new Error(`Bad ${what}`)
  return v
}

// watchers are per window, a closed window lets go of everything it watched
const tracked = new Set<number>()
function watcherKey(event: IpcMainInvokeEvent): string {
  const id = event.sender.id
  if (!tracked.has(id)) {
    tracked.add(id)
    event.sender.once('destroyed', () => {
      tracked.delete(id)
      unwatchAll(String(id))
    })
  }
  return String(id)
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
  ipcMain.handle(OBS_CHANNELS.saveSettings, (event, brandId: unknown, patch: unknown) => {
    trusted(event, brandId)
    return saveRecordingSettings(brandId, patch)
  })
  ipcMain.handle(OBS_CHANNELS.status, (event, brandId: unknown) => {
    trusted(event, brandId)
    return obsStatus(brandId)
  })
  ipcMain.handle(OBS_CHANNELS.scenes, (event, brandId: unknown) => {
    trusted(event, brandId)
    return obsScenes(brandId)
  })
  ipcMain.handle(OBS_CHANNELS.switchScene, (event, brandId: unknown, scene: unknown) => {
    trusted(event, brandId)
    return switchScene(brandId, text(scene, 'scene'))
  })
  ipcMain.handle(OBS_CHANNELS.screenshot, (event, brandId: unknown) => {
    trusted(event, brandId)
    return previewFrame(brandId)
  })
  // the user pressed Record on the card or pane: no approval prompt, the same ownership and idle checks
  ipcMain.handle(OBS_CHANNELS.startRecording, async (event, brandId: unknown, projectId: unknown, threadId: unknown) => {
    trusted(event, brandId)
    await startRecording(brandId, project(brandId, projectId), thread(threadId))
    return liveState(brandId)
  })
  ipcMain.handle(OBS_CHANNELS.stopRecording, async (event, brandId: unknown, projectId: unknown) => {
    trusted(event, brandId)
    await stopRecording(brandId, project(brandId, projectId))
    return liveState(brandId)
  })
  ipcMain.handle(OBS_CHANNELS.takes, (event, brandId: unknown, projectId: unknown) => {
    trusted(event, brandId)
    return recentTakes(brandId, project(brandId, projectId))
  })
  ipcMain.handle(OBS_CHANNELS.showCard, async (event, brandId: unknown, threadId: unknown, projectId: unknown) => {
    trusted(event, brandId)
    const t = thread(threadId)
    if (!t) throw new Error('Bad chat')
    const now = Date.now()
    const card: ObsCard = {
      id: newCardId(), brandId, threadId: t, messageId: null, at: now, updatedAt: now, type: 'obs',
      projectId: projectId === null || projectId === undefined ? null : project(brandId, projectId)
    }
    await addCard(card)
  })
  ipcMain.handle(OBS_CHANNELS.watch, (event, brandId: unknown) => {
    trusted(event, brandId)
    return watch(brandId, watcherKey(event))
  })
  ipcMain.handle(OBS_CHANNELS.unwatch, (event, brandId: unknown) => {
    trusted(event, brandId)
    unwatch(brandId, watcherKey(event))
  })
}
