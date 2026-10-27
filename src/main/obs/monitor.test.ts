import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObsEventHandlers } from './client'
import { ObsMonitor, sceneNames } from './monitor'

class FakeClient {
  static last: FakeClient
  connected = false
  handlers?: ObsEventHandlers
  requests: string[] = []
  constructor() { FakeClient.last = this }
  async connect(_endpoint: string, _password: string | undefined, handlers: ObsEventHandlers): Promise<void> {
    this.handlers = handlers
    this.connected = true
  }
  async request(name: string): Promise<Record<string, unknown>> {
    this.requests.push(name)
    if (name === 'GetRecordStatus') return { outputActive: false, outputDuration: 0 }
    if (name === 'GetStreamStatus') return { outputActive: false }
    if (name === 'GetSceneList') return { currentProgramSceneName: 'Camera', scenes: [{ sceneName: 'Screen' }, { sceneName: 'Camera' }] }
    if (name === 'GetSourceScreenshot') return { imageData: 'data:image/jpg;base64,AAAA' }
    throw new Error(name)
  }
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.handlers?.onClose(new Error('closed'))
  }
}

afterEach(() => vi.useRealTimers())

describe('OBS monitor', () => {
  it('follows record state and scenes from events and reconnects with backoff', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const monitor = new ObsMonitor('brand-a', {
      credentials: async () => ({ endpoint: 'ws://127.0.0.1:4455/', password: '' }),
      onEvent: (_m, type) => events.push(type),
      onConnected: () => events.push('connected'),
      changed: () => {}
    }, () => new FakeClient() as never)
    await monitor.start()
    expect(monitor.state).toMatchObject({ connected: true, recording: false, currentScene: 'Camera', scenes: ['Camera', 'Screen'] })
    const first = FakeClient.last
    first.handlers!.onEvent('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    first.handlers!.onEvent('CurrentProgramSceneChanged', { sceneName: 'Screen' })
    expect(monitor.state).toMatchObject({ recording: true, currentScene: 'Screen' })
    expect(await monitor.screenshot()).toBe('data:image/jpg;base64,AAAA')
    first.disconnect()
    expect(monitor.state.connected).toBe(false)
    expect(monitor.gap).toBe(true)
    await vi.advanceTimersByTimeAsync(2100)
    expect(FakeClient.last).not.toBe(first)
    expect(monitor.state.connected).toBe(true)
    expect(events.filter((e) => e === 'connected')).toHaveLength(2)
    monitor.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(monitor.state.connected).toBe(false)
  })

  it('lists scenes top first like OBS shows them', () => {
    expect(sceneNames([{ sceneName: 'Bottom' }, { sceneName: 'Top' }, null])).toEqual(['Top', 'Bottom'])
  })
})
