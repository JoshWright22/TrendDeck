import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ObsConnectionInput, ObsPreferences, ObsStatus } from '@shared/obs'
import { findProject, projectFolder } from '../craft/paths'
import { addWatch } from '../media/watch'
import { ObsClient } from './client'
import { assertBrand, obsCredentials, obsPreferences, saveObsPreferences } from './preferences'

interface Ownership { brandId: string; projectId: string; profile: string; directory: string; recording: boolean; uncertain: boolean }
let owner: Ownership | null = null
let queue: Promise<unknown> = Promise.resolve()

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation)
  queue = result.catch(() => {})
  return result
}

async function session<T>(brandId: string, operation: (client: ObsClient) => Promise<T>): Promise<T> {
  assertBrand(brandId)
  const client = new ObsClient()
  try {
    const credentials = await obsCredentials(brandId)
    await client.connect(credentials.endpoint, credentials.password)
    credentials.password = undefined
    return await operation(client)
  } finally { client.disconnect() }
}

async function inspect(client: ObsClient): Promise<Omit<ObsStatus, 'connected' | 'endpoint'>> {
  const version = await client.request('GetVersion')
  const available = version.availableRequests
  const required = ['GetRecordStatus', 'GetStreamStatus', 'GetProfileList', 'GetSceneList', 'GetRecordDirectory', 'CreateProfile', 'SetCurrentProfile', 'SetRecordDirectory', 'StartRecord', 'StopRecord']
  if (!Array.isArray(available) || required.some((name) => !available.includes(name))) {
    throw new Error('Local OBS lacks required WebSocket v5 requests. Update OBS manually; nothing was changed')
  }
  const record = await client.request('GetRecordStatus')
  const stream = await client.request('GetStreamStatus')
  const profiles = await client.request('GetProfileList')
  const scenes = await client.request('GetSceneList')
  const directory = await client.request('GetRecordDirectory')
  if (typeof record.outputActive !== 'boolean' || typeof stream.outputActive !== 'boolean' ||
      typeof profiles.currentProfileName !== 'string' || !Array.isArray(profiles.profiles) || !profiles.profiles.every((profile) => typeof profile === 'string') ||
      typeof directory.recordDirectory !== 'string' || !Array.isArray(scenes.scenes)) throw new Error('Invalid OBS inspection response; nothing was changed')
  return {
    recording: record.outputActive,
    streaming: stream.outputActive,
    currentProfile: profiles.currentProfileName,
    profiles: profiles.profiles as string[],
    currentScene: typeof scenes.currentProgramSceneName === 'string' ? scenes.currentProgramSceneName : undefined,
    scenes: scenes.scenes.map((scene) => String(scene.sceneName)),
    recordDirectory: directory.recordDirectory
  }
}

async function requireIdle(client: ObsClient): Promise<void> {
  const record = await client.request('GetRecordStatus')
  const stream = await client.request('GetStreamStatus')
  if (record.outputActive !== false || stream.outputActive !== false) throw new Error('OBS is recording or streaming; no configuration changes are allowed')
}

function requireOwner(brandId: string, projectId: string, status: Omit<ObsStatus, 'connected' | 'endpoint'>): Ownership {
  if (!owner || owner.brandId !== brandId || owner.projectId !== projectId) throw new Error('This brand/project does not own OBS. Approve obs_setup_recording while OBS is idle first')
  if (owner.profile !== status.currentProfile || resolve(owner.directory) !== resolve(status.recordDirectory || '.')) {
    throw new Error('OBS profile or recording directory changed outside TrendDeck; inspect OBS and approve setup again')
  }
  return owner
}

export function configureObs(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences> {
  return exclusive(async () => {
    assertBrand(brandId)
    if (owner?.brandId === brandId) {
      if (owner.recording || owner.uncertain) throw new Error('Finish this brand recording before changing its OBS connection')
      await session(brandId, requireIdle)
    }
    const saved = await saveObsPreferences(brandId, input)
    if (owner?.brandId === brandId) owner = null
    return saved
  })
}

export function obsStatus(brandId: string): Promise<ObsStatus> {
  return exclusive(async () => {
    const preferences = await obsPreferences(brandId)
    try {
      const status = await session(brandId, inspect)
      return { connected: true, endpoint: preferences.endpoint, ...status, ownerBrandId: owner?.brandId }
    } catch (error) {
      return { connected: false, endpoint: preferences.endpoint, error: (error as Error).message, ownerBrandId: owner?.brandId }
    }
  })
}

export function setupRecording(brandId: string, projectId: string): Promise<unknown> {
  return exclusive(() => session(brandId, async (client) => {
    findProject(brandId, projectId)
    const status = await inspect(client)
    await requireIdle(client)
    if (owner && (owner.recording || owner.uncertain)) throw new Error('An OBS recording is owned or has an uncertain outcome. Inspect/stop it with the owning brand before setup')
    if (owner && owner.brandId !== brandId) await session(owner.brandId, requireIdle)
    const directory = join(await projectFolder(brandId, projectId), 'Recordings')
    await fs.mkdir(directory, { recursive: true })
    const profile = `TrendDeck-${brandId}-${projectId}`
    await requireIdle(client)
    if (!status.profiles?.includes(profile)) await client.request('CreateProfile', { profileName: profile })
    else if (status.currentProfile !== profile) await client.request('SetCurrentProfile', { profileName: profile })
    await requireIdle(client)
    await client.request('SetRecordDirectory', { recordDirectory: directory })
    const verified = await inspect(client)
    if (verified.currentProfile !== profile || resolve(verified.recordDirectory || '.') !== resolve(directory)) throw new Error('OBS did not apply the requested profile/directory; inspect it before retrying')
    owner = { brandId, projectId, profile, directory, recording: false, uncertain: false }
    try { await addWatch(brandId, directory, false) }
    catch { return { profile, directory, watchAdded: false, warning: 'OBS setup succeeded but the media watch could not be added. Add it in the media library' } }
    return { profile, directory, watchAdded: true, currentScene: verified.currentScene, scenes: verified.scenes }
  }))
}

export function startRecording(brandId: string, projectId: string): Promise<unknown> {
  return exclusive(() => session(brandId, async (client) => {
    const status = await inspect(client)
    const active = requireOwner(brandId, projectId, status)
    if (active.uncertain) throw new Error('Previous recording outcome is uncertain. Inspect OBS and use approved stop before retrying')
    await requireIdle(client)
    active.uncertain = true
    await client.request('StartRecord')
    active.recording = true
    active.uncertain = false
    return { recording: true, directory: active.directory }
  }))
}

export function stopRecording(brandId: string, projectId: string): Promise<unknown> {
  return exclusive(() => session(brandId, async (client) => {
    const status = await inspect(client)
    const active = requireOwner(brandId, projectId, status)
    if (!active.recording && !active.uncertain) throw new Error('TrendDeck did not start this recording; stop it in OBS manually')
    if (!status.recording) {
      active.recording = false
      active.uncertain = false
      return { recording: false, note: 'OBS recording was already stopped; no stop command sent' }
    }
    active.uncertain = true
    const stopped = await client.request('StopRecord')
    active.recording = false
    active.uncertain = false
    return { recording: false, outputPath: typeof stopped.outputPath === 'string' ? stopped.outputPath : undefined }
  }))
}
