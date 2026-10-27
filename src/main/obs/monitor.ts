import { ObsClient } from './client'
import { EVENTS } from './protocol'

// one long-lived, read-mostly connection per brand while a card or the pane shows OBS or while
// TrendDeck owns a recording. it follows recording, streaming and scenes through OBS's events, so a
// recording stopped from OBS's own window is still seen, and the preview's screenshots go through it
// instead of a new connection per frame. it reconnects politely and never retries a write

export interface MonitorState {
  connected: boolean
  error: string
  recording: boolean
  streaming: boolean
  recordMs: number
  at: number
  currentScene: string | null
  scenes: string[]
}

export interface MonitorDeps {
  credentials: () => Promise<{ endpoint: string; password?: string }>
  // every event, after the monitor updated its own state
  onEvent: (monitor: ObsMonitor, eventType: string, data: Record<string, unknown>) => void
  // connected again (or the first time), state is fresh
  onConnected: (monitor: ObsMonitor) => void
  changed: (monitor: ObsMonitor) => void
}

const BACKOFF = [2000, 5000, 10000, 30000]
const SUBSCRIPTIONS = EVENTS.outputs | EVENTS.scenes | EVENTS.config

export class ObsMonitor {
  state: MonitorState = { connected: false, error: '', recording: false, streaming: false, recordMs: 0, at: Date.now(), currentScene: null, scenes: [] }
  endpoint = ''
  // the connection dropped at least once since this was cleared, events may have been missed
  gap = false
  private client: ObsClient | null = null
  private connecting: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private wanted = false
  private shot: Promise<string> | null = null

  constructor(readonly brandId: string, private readonly deps: MonitorDeps, private readonly makeClient = () => new ObsClient()) {}

  get live(): ObsClient | null {
    return this.client?.connected ? this.client : null
  }

  start(): Promise<void> {
    this.wanted = true
    if (this.live) return Promise.resolve()
    if (this.connecting) return this.connecting
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.connect()
  }

  stop(): void {
    this.wanted = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const c = this.client
    this.client = null
    c?.disconnect()
    this.state = { ...this.state, connected: false }
  }

  // connection settings changed: drop it and connect again with the new ones
  restart(): void {
    const wanted = this.wanted
    this.stop()
    this.attempt = 0
    if (wanted) void this.start()
  }

  private connect(): Promise<void> {
    const run = async (): Promise<void> => {
      const client = this.makeClient()
      try {
        const credentials = await this.deps.credentials()
        this.endpoint = credentials.endpoint
        await client.connect(credentials.endpoint, credentials.password, {
          subscriptions: SUBSCRIPTIONS,
          onEvent: (type, data) => this.event(type, data),
          onClose: (error) => this.closed(client, error)
        })
        credentials.password = undefined
        if (!this.wanted) {
          client.disconnect()
          return
        }
        this.client = client
        this.attempt = 0
        await this.refresh()
        this.state.error = ''
        this.deps.onConnected(this)
      } catch (error) {
        if (this.client === client) this.client = null
        client.disconnect()
        this.state = { ...this.state, connected: false, error: (error as Error).message }
        this.deps.changed(this)
        this.schedule()
      }
    }
    this.connecting = run().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private closed(client: ObsClient, error: Error): void {
    if (this.client !== client) return
    this.client = null
    this.gap = true
    this.state = { ...this.state, connected: false, error: this.wanted ? error.message : '' }
    this.deps.changed(this)
    this.schedule()
  }

  private schedule(): void {
    if (!this.wanted || this.timer) return
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]
    this.attempt++
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.wanted && !this.client) void this.connect()
    }, delay)
  }

  // reads only
  async refresh(): Promise<void> {
    const c = this.live
    if (!c) return
    const [record, stream, scenes] = await Promise.all([c.request('GetRecordStatus'), c.request('GetStreamStatus'), c.request('GetSceneList')])
    this.state = {
      connected: true,
      error: '',
      recording: record.outputActive === true,
      streaming: stream.outputActive === true,
      recordMs: typeof record.outputDuration === 'number' ? record.outputDuration : 0,
      at: Date.now(),
      currentScene: typeof scenes.currentProgramSceneName === 'string' ? scenes.currentProgramSceneName : null,
      scenes: Array.isArray(scenes.scenes) ? sceneNames(scenes.scenes) : []
    }
    this.deps.changed(this)
  }

  private event(type: string, data: Record<string, unknown>): void {
    const s = this.state
    switch (type) {
      case 'RecordStateChanged':
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.state = { ...s, recording: true, recordMs: 0, at: Date.now() }
        else if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') this.state = { ...s, recording: false, recordMs: 0, at: Date.now() }
        break
      case 'StreamStateChanged':
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.state = { ...s, streaming: true }
        else if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') this.state = { ...s, streaming: false }
        break
      case 'CurrentProgramSceneChanged':
        if (typeof data.sceneName === 'string') this.state = { ...s, currentScene: data.sceneName }
        break
      case 'SceneListChanged':
        if (Array.isArray(data.scenes)) this.state = { ...s, scenes: sceneNames(data.scenes) }
        break
      case 'SceneCollectionListChanged':
      case 'CurrentSceneCollectionChanged':
      case 'CurrentProfileChanged':
        void this.refresh().catch(() => {})
        break
    }
    this.deps.onEvent(this, type, data)
    this.deps.changed(this)
  }

  // the program scene as a small jpg data URL for the preview. one at a time: a caller that asks
  // while one is on its way gets that one
  screenshot(width = 480): Promise<string> {
    const c = this.live
    if (!c) return Promise.reject(new Error('OBS is not connected'))
    if (this.shot) return this.shot
    const scene = this.state.currentScene
    if (!scene) return Promise.reject(new Error('OBS has no program scene'))
    this.shot = c
      .request('GetSourceScreenshot', { sourceName: scene, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 60 })
      .then((r) => {
        if (typeof r.imageData !== 'string' || !r.imageData.startsWith('data:image/')) throw new Error('OBS sent no picture')
        return r.imageData
      })
      .finally(() => {
        this.shot = null
      })
    return this.shot
  }
}

// OBS lists scenes bottom first, the way its own scene list shows them is top first
export function sceneNames(list: unknown[]): string[] {
  return list
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>).sceneName : undefined))
    .filter((n): n is string => typeof n === 'string')
    .reverse()
}
