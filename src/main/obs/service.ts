import { promises as fs } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { OBS_CHANNELS, type ObsConnectionInput, type ObsInput, type ObsLive, type ObsPreferences, type ObsRecordingSettings, type ObsScenes, type ObsStatus, type ObsTake } from '@shared/obs'
import { findProject, projectFolder } from '../craft/paths'
import { broadcast } from '../gateway/wait'
import { ingestRecording } from '../takes/ingest'
import { ObsClient } from './client'
import { ObsMonitor, sceneNames } from './monitor'
import { assertBrand, obsCredentials, obsPreferences, recordingSettings, saveObsPreferences } from './preferences'
import { isRequestError, ObsRequestError } from './protocol'
import { fill, isInsideDir, isRecordingFile, recordingFolder, samePath } from './rules'

// everything TrendDeck does to OBS. writes go one at a time through `exclusive`, each config write
// right after a fresh check that OBS isn't recording or streaming. a recording TrendDeck starts is
// owned by its brand and project; nothing else can stop it and TrendDeck never adopts or stops a
// recording it didn't start. OBS's own record folder (and file name format, if a brand sets one)
// is remembered when a recording starts and put back after it stops

interface Previous { profile: string; directory: string; filename: string | null }

// OBS settings TrendDeck changed and has to put back, from setup until they're restored
interface Restore {
  brandId: string
  endpoint: string
  // the profile the folder and file name were written to
  profile: string
  directory: string
  filenameSet: string | null
  previous: Previous
}

interface Ownership extends Restore {
  projectId: string
  threadId: string | null
  recording: boolean
  // a start or stop was sent and its outcome is unknown, nothing else runs until it's resolved
  uncertain: boolean
  startedAt: number
  finalized: boolean
}

let owner: Ownership | null = null
let pending: Restore | null = null
const notes = new Map<string, string>()
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

// the brand's live monitor connection when there is one, a short session otherwise
function withClient<T>(brandId: string, operation: (client: ObsClient) => Promise<T>): Promise<T> {
  assertBrand(brandId)
  const live = monitors.get(brandId)?.live
  return live ? operation(live) : session(brandId, operation)
}

// reads skip the queue on the monitor connection, a short session waits its turn
function read<T>(brandId: string, operation: (client: ObsClient) => Promise<T>): Promise<T> {
  assertBrand(brandId)
  const live = monitors.get(brandId)?.live
  return live ? operation(live) : exclusive(() => session(brandId, operation))
}

const REQUIRED = ['GetRecordStatus', 'GetStreamStatus', 'GetProfileList', 'GetSceneList', 'GetRecordDirectory', 'SetCurrentProfile', 'SetRecordDirectory', 'StartRecord', 'StopRecord']

async function inspect(client: ObsClient): Promise<Omit<ObsStatus, 'connected' | 'endpoint'>> {
  const version = await client.request('GetVersion')
  const available = version.availableRequests
  if (!Array.isArray(available) || REQUIRED.some((name) => !available.includes(name))) {
    throw new Error('Local OBS lacks required WebSocket v5 requests. Update OBS manually; nothing was changed')
  }
  const record = await client.request('GetRecordStatus')
  const stream = await client.request('GetStreamStatus')
  const profiles = await client.request('GetProfileList')
  const scenes = await client.request('GetSceneList')
  const directory = await client.request('GetRecordDirectory')
  const collections = available.includes('GetSceneCollectionList') ? await client.request('GetSceneCollectionList') : {}
  if (typeof record.outputActive !== 'boolean' || typeof stream.outputActive !== 'boolean' ||
      typeof profiles.currentProfileName !== 'string' || !Array.isArray(profiles.profiles) || !profiles.profiles.every((profile) => typeof profile === 'string') ||
      typeof directory.recordDirectory !== 'string' || !Array.isArray(scenes.scenes)) throw new Error('Invalid OBS inspection response; nothing was changed')
  const list = Array.isArray(collections.sceneCollections) ? collections.sceneCollections.filter((c): c is string => typeof c === 'string') : undefined
  return {
    recording: record.outputActive,
    streaming: stream.outputActive,
    recordMs: typeof record.outputDuration === 'number' ? record.outputDuration : 0,
    currentProfile: profiles.currentProfileName,
    profiles: profiles.profiles as string[],
    currentSceneCollection: typeof collections.currentSceneCollectionName === 'string' ? collections.currentSceneCollectionName : undefined,
    sceneCollections: list,
    currentScene: typeof scenes.currentProgramSceneName === 'string' ? scenes.currentProgramSceneName : undefined,
    scenes: sceneNames(scenes.scenes),
    recordDirectory: directory.recordDirectory
  }
}

async function requireIdle(client: ObsClient): Promise<void> {
  const record = await client.request('GetRecordStatus')
  const stream = await client.request('GetStreamStatus')
  if (record.outputActive !== false || stream.outputActive !== false) throw new Error('OBS is recording or streaming; no configuration changes are allowed')
}

const busy = (): boolean => !!owner && !owner.finalized && (owner.recording || owner.uncertain)

function setNote(brandId: string, note: string): void {
  if (note) notes.set(brandId, note)
  else notes.delete(brandId)
  publish(brandId)
}

// ---- putting OBS's own settings back ----

// one attempt, never retried on its own. while OBS is busy it waits for the next time OBS goes idle
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

// right after StopRecord OBS can still be finishing the file, waitMs reads its state a few times
async function restoreLocked(client: ObsClient, waitMs = 0): Promise<void> {
  const r = pending
  if (!r) return
  if (owner && !owner.finalized && owner.endpoint === r.endpoint) return
  let record = await client.request('GetRecordStatus')
  for (let waited = 0; record.outputActive !== false && waited < waitMs; waited += 250) {
    await sleep(250)
    record = await client.request('GetRecordStatus')
  }
  const stream = await client.request('GetStreamStatus')
  if (record.outputActive !== false || stream.outputActive !== false) {
    setNote(r.brandId, `OBS's recording folder still points at the project. TrendDeck puts it back to ${r.previous.directory} when OBS stops recording and streaming.`)
    return
  }
  pending = null
  try {
    const profiles = await client.request('GetProfileList')
    if (profiles.currentProfileName !== r.profile) {
      setNote(r.brandId, `OBS switched profiles, so the recording folder in profile "${r.profile}" still points at the project. Set it back in OBS, Settings, Output.`)
      return
    }
    const now = await client.request('GetRecordDirectory')
    // changed by someone since, leave their choice alone
    if (typeof now.recordDirectory !== 'string' || !samePath(now.recordDirectory, r.directory)) return setNote(r.brandId, '')
    await requireIdle(client)
    await client.request('SetRecordDirectory', { recordDirectory: r.previous.directory })
    if (r.filenameSet !== null && r.previous.filename !== null) {
      const format = await client.request('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting' })
      if (format.parameterValue === r.filenameSet) {
        await requireIdle(client)
        await client.request('SetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting', parameterValue: r.previous.filename })
      }
    }
    setNote(r.brandId, '')
  } catch {
    setNote(r.brandId, `Couldn't set OBS's recording folder back to ${r.previous.directory}. Set it in OBS, Settings, Output.`)
  }
}

function queueRestore(brandId: string): void {
  void exclusive(async () => {
    if (!pending || pending.brandId !== brandId) return
    await withClient(brandId, restoreLocked)
  }).catch((err) => console.error('obs: putting OBS settings back failed', (err as Error).message))
}

// ---- a TrendDeck recording ends: put OBS back, then the take goes to the chat ----

async function newestRecording(dir: string, since: number): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  let best: { path: string; at: number } | null = null
  for (const name of names) {
    if (!isRecordingFile(name)) continue
    const st = await fs.stat(join(dir, name)).catch(() => null)
    if (st?.isFile() && st.mtimeMs >= since - 5000 && (!best || st.mtimeMs > best.at)) best = { path: join(dir, name), at: st.mtimeMs }
  }
  return best?.path ?? null
}

async function importTake(o: Ownership, path: string | null): Promise<void> {
  if (!path) return console.log('obs: the recording stopped but its file was not found, nothing to import')
  const settings = await recordingSettings(o.brandId)
  if (!settings.autoImport) return console.log('obs: auto-import is off, not importing', basename(path))
  const root = await fs.realpath(await projectFolder(o.brandId, o.projectId))
  const real = await fs.realpath(path).catch(() => null)
  if (!real || !isInsideDir(root, real)) return console.log('obs: the recording is not inside the project folder, not importing it')
  console.log(`obs: importing take ${relative(root, real)} for project ${o.projectId}`)
  await ingestRecording({ brandId: o.brandId, projectId: o.projectId, path: real, source: 'obs', threadId: o.threadId })
}

async function finalizeLocked(o: Ownership, path: string | null, client?: ObsClient): Promise<void> {
  if (o.finalized) return
  o.finalized = true
  o.recording = false
  o.uncertain = false
  if (owner === o) owner = null
  try {
    if (client) await restoreLocked(client, 4000)
    else await withClient(o.brandId, (c) => restoreLocked(c, 4000))
  } catch {
    if (pending) setNote(o.brandId, `OBS's recording folder still points at the project. TrendDeck puts it back to ${pending.previous.directory} next time it reaches OBS.`)
  }
  publish(o.brandId)
  const file = path ?? (await newestRecording(o.directory, o.startedAt))
  void importTake(o, file).catch((err) => console.error('obs: importing the take failed', (err as Error).message))
  syncMonitor(o.brandId)
}

// ---- monitors ----

const monitors = new Map<string, ObsMonitor>()
const watchers = new Map<string, Map<string, number>>()
const lingers = new Map<string, ReturnType<typeof setTimeout>>()

function wanted(brandId: string): boolean {
  const w = watchers.get(brandId)
  return (!!w && [...w.values()].some((n) => n > 0)) || (busy() && owner!.brandId === brandId) || pending?.brandId === brandId
}

function monitorFor(brandId: string): ObsMonitor {
  let m = monitors.get(brandId)
  if (!m) {
    m = new ObsMonitor(brandId, {
      credentials: () => obsCredentials(brandId),
      onEvent: onMonitorEvent,
      onConnected: onMonitorConnected,
      changed: (x) => publish(x.brandId)
    })
    monitors.set(brandId, m)
  }
  return m
}

function syncMonitor(brandId: string): void {
  const t = lingers.get(brandId)
  if (t) clearTimeout(t)
  lingers.delete(brandId)
  if (wanted(brandId)) {
    void monitorFor(brandId).start()
    return
  }
  // a card scrolling in and out shouldn't connect and drop every time
  if (!monitors.has(brandId)) return
  lingers.set(brandId, setTimeout(() => {
    lingers.delete(brandId)
    if (!wanted(brandId)) monitors.get(brandId)?.stop()
  }, 10_000))
}

const STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED'
const STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED'

function onMonitorEvent(m: ObsMonitor, type: string, data: Record<string, unknown>): void {
  if (type !== 'RecordStateChanged' && type !== 'StreamStateChanged') return
  const o = owner
  if (type === 'RecordStateChanged' && o && !o.finalized && o.brandId === m.brandId) {
    if (data.outputState === STARTED && o.uncertain && !o.recording) {
      o.recording = true
      o.uncertain = false
    } else if (data.outputState === STOPPED && (o.recording || o.uncertain)) {
      // stopped from OBS's own window, or the answer to our StopRecord. finalize runs once
      o.recording = false
      const path = typeof data.outputPath === 'string' ? data.outputPath : null
      void exclusive(() => finalizeLocked(o, path)).catch((err) => console.error('obs: finishing the recording failed', (err as Error).message))
      return
    }
  }
  if (data.outputState === STOPPED && pending?.brandId === m.brandId) queueRestore(m.brandId)
}

function onMonitorConnected(m: ObsMonitor): void {
  const o = owner
  // OBS stopped while the connection was down
  if (o && !o.finalized && o.brandId === m.brandId && o.recording && !m.state.recording) {
    o.recording = false
    void exclusive(() => finalizeLocked(o, null)).catch(() => {})
  } else if (pending?.brandId === m.brandId && !m.state.recording && !m.state.streaming) queueRestore(m.brandId)
  publish(m.brandId)
}

export function liveState(brandId: string): ObsLive {
  const m = monitors.get(brandId)
  const s = m?.state
  const o = owner && !owner.finalized && owner.brandId === brandId && (owner.recording || owner.uncertain) ? owner : null
  return {
    brandId,
    connected: !!s?.connected,
    error: s?.connected ? '' : s?.error || '',
    recording: !!s?.recording,
    streaming: !!s?.streaming,
    recordMs: s?.recordMs ?? 0,
    at: s?.at ?? Date.now(),
    ours: !!o,
    projectId: o?.projectId ?? null,
    uncertain: !!o?.uncertain,
    currentScene: s?.currentScene ?? null,
    scenes: s?.scenes ?? [],
    note: notes.get(brandId) ?? ''
  }
}

function publish(brandId: string): void {
  try {
    broadcast(OBS_CHANNELS.live, liveState(brandId))
  } catch {
    // no window yet
  }
}

// a card or the pane is on screen. key tells watchers apart, e.g. the window's id
export async function watch(brandId: string, key: string): Promise<ObsLive> {
  assertBrand(brandId)
  const w = watchers.get(brandId) ?? new Map<string, number>()
  watchers.set(brandId, w)
  w.set(key, (w.get(key) ?? 0) + 1)
  syncMonitor(brandId)
  await monitorFor(brandId).start().catch(() => {})
  return liveState(brandId)
}

export function unwatch(brandId: string, key: string): void {
  const w = watchers.get(brandId)
  if (!w) return
  const n = (w.get(key) ?? 0) - 1
  if (n > 0) w.set(key, n)
  else w.delete(key)
  syncMonitor(brandId)
}

// a window went away, everything it watched goes with it
export function unwatchAll(key: string): void {
  for (const [brandId, w] of watchers) {
    if (w.delete(key)) syncMonitor(brandId)
  }
}

// the preview's frame. only through a live monitor, never a connection per frame
export async function previewFrame(brandId: string): Promise<string | null> {
  assertBrand(brandId)
  const m = monitors.get(brandId)
  if (!m?.live) return null
  try {
    return await m.screenshot(480)
  } catch {
    return null
  }
}

// ---- connection and settings ----

export function configureObs(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences> {
  return exclusive(async () => {
    assertBrand(brandId)
    if (owner?.brandId === brandId && busy()) throw new Error('Finish this brand recording before changing its OBS connection')
    if (pending?.brandId === brandId) throw new Error("TrendDeck still has to put OBS's recording folder back. Wait until OBS stops recording and streaming")
    const saved = await saveObsPreferences(brandId, input)
    monitors.get(brandId)?.restart()
    return saved
  })
}

export function obsStatus(brandId: string): Promise<ObsStatus> {
  return exclusive(async () => {
    const preferences = await obsPreferences(brandId)
    const note = notes.get(brandId)
    try {
      const status = await withClient(brandId, inspect)
      return { connected: true, endpoint: preferences.endpoint, ...status, ownerBrandId: busy() ? owner?.brandId : undefined, ...(note ? { note } : {}) }
    } catch (error) {
      return { connected: false, endpoint: preferences.endpoint, error: (error as Error).message, ownerBrandId: busy() ? owner?.brandId : undefined, ...(note ? { note } : {}) }
    }
  })
}

// where OBS puts recordings, for finding footage. the folder OBS has now, and the user's own
// folder when TrendDeck pointed OBS at a project for a recording. empty when OBS isn't reachable
export async function obsRecordFolders(brandId: string): Promise<string[]> {
  assertBrand(brandId)
  const out: string[] = []
  for (const r of [owner, pending]) if (r && r.brandId === brandId) out.push(r.previous.directory)
  try {
    const now = await read(brandId, (client) => client.request('GetRecordDirectory'))
    if (typeof now.recordDirectory === 'string' && now.recordDirectory) out.unshift(now.recordDirectory)
  } catch {
    // not running or not set up, the caller falls back to OBS's own config and its default
  }
  return out
}

// ---- scenes, audio, pictures ----

async function scenesOf(client: ObsClient): Promise<ObsScenes> {
  const scenes = await client.request('GetSceneList')
  const inputs = await client.request('GetInputList')
  const out: ObsInput[] = []
  for (const raw of (Array.isArray(inputs.inputs) ? inputs.inputs : []).slice(0, 60)) {
    const i = raw as Record<string, unknown>
    if (typeof i.inputName !== 'string') continue
    const kind = typeof i.inputKind === 'string' ? i.inputKind : ''
    // OBS_SOURCE_AUDIO, inputs without it have no mute
    const audio = typeof i.inputKindCaps === 'number' ? (i.inputKindCaps & 2) !== 0 : true
    let muted: boolean | null = null
    if (audio) {
      try {
        const m = await client.request('GetInputMute', { inputName: i.inputName })
        muted = typeof m.inputMuted === 'boolean' ? m.inputMuted : null
      } catch (err) {
        if (!(isRequestError(err))) throw err
      }
    }
    out.push({ name: i.inputName, kind, muted })
  }
  return {
    currentScene: typeof scenes.currentProgramSceneName === 'string' ? scenes.currentProgramSceneName : null,
    scenes: Array.isArray(scenes.scenes) ? sceneNames(scenes.scenes) : [],
    inputs: out
  }
}

export function obsScenes(brandId: string): Promise<ObsScenes> {
  return read(brandId, scenesOf)
}

export function switchScene(brandId: string, scene: string): Promise<ObsScenes> {
  return exclusive(() => withClient(brandId, async (client) => {
    const list = await client.request('GetSceneList')
    if (!Array.isArray(list.scenes) || !sceneNames(list.scenes).includes(scene)) throw new Error(`OBS has no scene called "${scene}"`)
    await client.request('SetCurrentProgramScene', { sceneName: scene })
    return scenesOf(client)
  }))
}

export function setInputMute(brandId: string, input: string, muted: boolean): Promise<ObsInput> {
  return exclusive(() => withClient(brandId, async (client) => {
    const found = (await scenesOf(client)).inputs.find((i) => i.name === input)
    if (!found) throw new Error(`OBS has no input called "${input}"`)
    if (found.muted === null) throw new Error(`"${input}" has no audio to mute`)
    await client.request('SetInputMute', { inputName: input, inputMuted: muted })
    const now = await client.request('GetInputMute', { inputName: input })
    return { ...found, muted: now.inputMuted === true }
  }))
}

export async function isStreaming(brandId: string): Promise<boolean> {
  return read(brandId, async (client) => (await client.request('GetStreamStatus')).outputActive === true)
}

// a png of the program scene or a named source, for the agent
export function screenshot(brandId: string, source: string | undefined, width: number): Promise<{ png: Buffer; source: string }> {
  return read(brandId, async (client) => {
    let name = source
    if (!name) {
      const scenes = await client.request('GetSceneList')
      if (typeof scenes.currentProgramSceneName !== 'string') throw new Error('OBS has no program scene')
      name = scenes.currentProgramSceneName
    }
    let shot: Record<string, unknown>
    try {
      shot = await client.request('GetSourceScreenshot', { sourceName: name, imageFormat: 'png', imageWidth: width })
    } catch (err) {
      if (isRequestError(err)) throw new Error(`OBS couldn't take a picture of "${name}". Check the name with obs_scenes`)
      throw err
    }
    const m = typeof shot.imageData === 'string' ? /^data:image\/png;base64,(.+)$/.exec(shot.imageData) : null
    if (!m) throw new Error('OBS sent no picture')
    return { png: Buffer.from(m[1], 'base64'), source: name }
  })
}

// ---- recording ----

interface Plan { settings: ObsRecordingSettings; directory: string; names: { project: string; brand: string }; endpoint: string }

async function plan(brandId: string, projectId: string): Promise<Plan> {
  const { brandName, project } = findProject(brandId, projectId)
  const settings = await recordingSettings(brandId)
  const names = { project: project.name, brand: brandName }
  const directory = recordingFolder(await projectFolder(brandId, projectId), settings.folder, names)
  return { settings, directory, names, endpoint: (await obsPreferences(brandId)).endpoint }
}

// the brand's profile and scene collection, only ones that exist in OBS, only while idle
async function applyProfile(client: ObsClient, settings: ObsRecordingSettings): Promise<Omit<ObsStatus, 'connected' | 'endpoint'>> {
  let status = await inspect(client)
  if (status.recording) throw new Error("OBS is already recording outside TrendDeck. Stop it in OBS first, TrendDeck won't take over a recording it didn't start")
  if (status.streaming) throw new Error("OBS is streaming. TrendDeck doesn't change OBS settings while you're live")
  let changed = false
  if (settings.sceneCollection && settings.sceneCollection !== status.currentSceneCollection) {
    if (!status.sceneCollections?.includes(settings.sceneCollection)) throw new Error(`OBS has no scene collection called "${settings.sceneCollection}". Pick another in Settings, OBS`)
    await requireIdle(client)
    await client.request('SetCurrentSceneCollection', { sceneCollectionName: settings.sceneCollection })
    changed = true
  }
  if (settings.profile && settings.profile !== status.currentProfile) {
    if (!status.profiles?.includes(settings.profile)) throw new Error(`OBS has no profile called "${settings.profile}". Pick another in Settings, OBS`)
    await requireIdle(client)
    await client.request('SetCurrentProfile', { profileName: settings.profile })
    changed = true
  }
  if (changed) {
    status = await inspect(client)
    if ((settings.profile && status.currentProfile !== settings.profile) || (settings.sceneCollection && status.currentSceneCollection !== settings.sceneCollection)) {
      throw new Error("OBS didn't switch to the brand's profile or scene collection. Check OBS before trying again")
    }
  }
  return status
}

// the agent's setup step: the brand's profile and scene collection, and the project's folder.
// the record folder itself is only set while a TrendDeck recording runs
export function setupRecording(brandId: string, projectId: string): Promise<unknown> {
  return exclusive(async () => {
    if (busy()) throw new Error('An OBS recording is owned or has an uncertain outcome. Inspect/stop it with the owning brand before setup')
    const p = await plan(brandId, projectId)
    return withClient(brandId, async (client) => {
      const status = await applyProfile(client, p.settings)
      await fs.mkdir(p.directory, { recursive: true })
      return {
        profile: status.currentProfile,
        sceneCollection: status.currentSceneCollection,
        folder: p.directory,
        filename: p.settings.filename ? fill(p.settings.filename, p.names) : "OBS's own",
        currentScene: status.currentScene,
        scenes: status.scenes,
        note: "OBS records into this folder only while a TrendDeck recording runs; its own folder is put back when it stops."
      }
    })
  })
}

// from the card (no prompt) or the agent's approved obs_start_recording. same checks either way
export function startRecording(brandId: string, projectId: string, threadId: string | null = null): Promise<{ recording: true; folder: string; filename: string }> {
  return exclusive(async () => {
    if (busy()) {
      throw new Error(owner!.uncertain ? 'Previous recording outcome is uncertain. Inspect OBS and use approved stop before retrying' : 'TrendDeck is already recording in OBS. Stop that one first')
    }
    const p = await plan(brandId, projectId)
    const out = await withClient(brandId, async (client) => {
      if (pending && pending.endpoint === p.endpoint) await restoreLocked(client)
      const status = await applyProfile(client, p.settings)
      if (pending && pending.endpoint === p.endpoint) throw new Error("TrendDeck couldn't put OBS's recording folder back yet. Check OBS, Settings, Output")
      await fs.mkdir(p.directory, { recursive: true })
      const previous: Previous = { profile: status.currentProfile!, directory: status.recordDirectory!, filename: null }
      let filenameSet: string | null = null
      if (p.settings.filename) {
        const format = await client.request('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting' })
        previous.filename = typeof format.parameterValue === 'string' ? format.parameterValue : ''
        filenameSet = fill(p.settings.filename, p.names)
      }
      const restore: Restore = { brandId, endpoint: p.endpoint, profile: previous.profile, directory: p.directory, filenameSet, previous }
      await requireIdle(client)
      // from here OBS may point at the project until restoreLocked puts it back
      pending = restore
      syncMonitor(brandId)
      try {
        await client.request('SetRecordDirectory', { recordDirectory: p.directory })
        if (filenameSet !== null) {
          await requireIdle(client)
          await client.request('SetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting', parameterValue: filenameSet })
        }
        const check = await client.request('GetRecordDirectory')
        if (typeof check.recordDirectory !== 'string' || !samePath(check.recordDirectory, p.directory)) {
          throw new ObsRequestError("OBS didn't take the project folder; nothing was recorded", 0)
        }
        await requireIdle(client)
      } catch (err) {
        // the outcome is known, put back what was changed, once
        if (isRequestError(err) || /recording or streaming/.test((err as Error).message)) await restoreLocked(client).catch(() => {})
        throw err
      }
      const o: Ownership = { ...restore, projectId, threadId, recording: false, uncertain: true, startedAt: Date.now(), finalized: false }
      owner = o
      const m = monitors.get(brandId)
      if (m) m.gap = !m.live
      try {
        await client.request('StartRecord')
      } catch (err) {
        if (isRequestError(err)) {
          o.uncertain = false
          o.finalized = true
          owner = null
          await restoreLocked(client).catch(() => {})
          throw new Error("OBS didn't start recording. Check OBS's output settings, then try again")
        }
        throw err
      }
      o.recording = true
      o.uncertain = false
      o.startedAt = Date.now()
      return { recording: true as const, folder: p.directory, filename: filenameSet ?? "OBS's own" }
    })
    syncMonitor(brandId)
    publish(brandId)
    return out
  })
}

export function stopRecording(brandId: string, projectId: string): Promise<{ recording: false; outputPath?: string; note?: string }> {
  return exclusive(async () => {
    assertBrand(brandId)
    const o = owner && !owner.finalized ? owner : null
    if (!o || o.brandId !== brandId || o.projectId !== projectId) throw new Error('This brand/project does not own OBS. TrendDeck only stops recordings it started; stop this one in OBS')
    if (!o.recording && !o.uncertain) throw new Error('TrendDeck did not start this recording; stop it in OBS manually')
    const out = await withClient(brandId, async (client) => {
      const record = await client.request('GetRecordStatus')
      if (record.outputActive !== true) {
        await finalizeLocked(o, null, client)
        return { recording: false as const, note: 'OBS recording was already stopped; no stop command sent' }
      }
      // events may have been missed: a much shorter recording than ours is someone else's
      const m = monitors.get(brandId)
      if (o.recording && (!m || m.gap) && record.outputPaused !== true && typeof record.outputDuration === 'number' && record.outputDuration < Date.now() - o.startedAt - 15_000) {
        throw new Error("The recording in OBS now isn't the one TrendDeck started. Stop it in OBS yourself")
      }
      o.uncertain = true
      const stopped = await client.request('StopRecord')
      const path = typeof stopped.outputPath === 'string' ? stopped.outputPath : null
      await finalizeLocked(o, path, client)
      return { recording: false as const, ...(path ? { outputPath: path } : {}) }
    })
    publish(brandId)
    return out
  })
}

// ---- streaming, only with the user's approval every time. stream keys and services are never read or changed ----

export function startStream(brandId: string): Promise<{ streaming: true }> {
  return exclusive(() => withClient(brandId, async (client) => {
    if ((await client.request('GetStreamStatus')).outputActive === true) throw new Error('OBS is already live')
    await client.request('StartStream')
    return { streaming: true as const }
  }))
}

export function stopStream(brandId: string): Promise<{ streaming: false }> {
  return exclusive(() => withClient(brandId, async (client) => {
    if ((await client.request('GetStreamStatus')).outputActive !== true) throw new Error("OBS isn't streaming")
    await client.request('StopStream')
    return { streaming: false as const }
  }))
}

// ---- takes ----

export async function recentTakes(brandId: string, projectId: string, max = 20): Promise<ObsTake[]> {
  assertBrand(brandId)
  const p = await plan(brandId, projectId)
  const root = await projectFolder(brandId, projectId)
  const names = await fs.readdir(p.directory).catch(() => [] as string[])
  const out: ObsTake[] = []
  for (const name of names) {
    if (!isRecordingFile(name)) continue
    const st = await fs.stat(join(p.directory, name)).catch(() => null)
    if (!st?.isFile()) continue
    out.push({ name, file: relative(root, join(p.directory, name)).split(/[\\/]+/).join('/'), size: st.size, modifiedAt: st.mtimeMs })
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, max)
}
