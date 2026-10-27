import { randomUUID } from 'node:crypto'
import { identify, normalizeEndpoint, parseFrame, responseData } from './protocol'

interface Pending {
  requestType: string
  resolve: (data: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// for a long-lived monitor connection: what to subscribe to, events as they come, and one call
// when an identified connection ends for any reason
export interface ObsEventHandlers {
  subscriptions: number
  onEvent: (eventType: string, eventData: Record<string, unknown>) => void
  onClose: (error: Error) => void
}

export class ObsClient {
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private ready = false
  private events: ObsEventHandlers | undefined

  constructor(private readonly timeoutMs = 8000) {}

  get connected(): boolean {
    return this.ready
  }

  async connect(endpoint: string, password?: string, events?: ObsEventHandlers): Promise<void> {
    if (this.socket) throw new Error('OBS client already connected')
    if (typeof WebSocket === 'undefined') throw new Error('This Electron runtime does not provide built-in WebSocket')
    const socket = new WebSocket(normalizeEndpoint(endpoint))
    this.socket = socket
    this.events = events
    await new Promise<void>((resolve, reject) => {
      let phase = 'hello'
      let settled = false
      const fail = (error: Error): void => {
        password = undefined
        clearTimeout(timer)
        if (!settled) { settled = true; reject(error) }
        this.disconnect(error)
      }
      const timer = setTimeout(() => fail(new Error('OBS connection timed out. Open OBS and enable Tools > WebSocket Server Settings')), this.timeoutMs)
      socket.addEventListener('error', () => fail(new Error('Cannot connect to OBS. Open local OBS and enable its WebSocket v5 server')))
      socket.addEventListener('close', (event) => fail(new Error(`OBS disconnected (code ${event.code}); reconnect and inspect status before retrying`)))
      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string') throw new Error('OBS must use the JSON WebSocket protocol')
          const frame = parseFrame(event.data)
          if (phase === 'hello') {
            if (frame.op !== 0) throw new Error('OBS did not send a v5 Hello')
            socket.send(JSON.stringify(identify(frame.d, password, events?.subscriptions ?? 0)))
            password = undefined
            phase = 'identify'
          } else if (phase === 'identify') {
            if (frame.op !== 2 || frame.d.negotiatedRpcVersion !== 1) throw new Error('OBS identification failed; check local server authentication')
            phase = 'ready'
            this.ready = true
            settled = true
            clearTimeout(timer)
            resolve()
          } else if (frame.op === 7) {
            const requestId = String(frame.d.requestId)
            const pending = this.pending.get(requestId)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(requestId)
            try { pending.resolve(responseData(frame.d, pending.requestType)) } catch (error) { pending.reject(error as Error) }
          } else if (frame.op === 5 && this.events && typeof frame.d.eventType === 'string') {
            const data = frame.d.eventData && typeof frame.d.eventData === 'object' && !Array.isArray(frame.d.eventData) ? frame.d.eventData as Record<string, unknown> : {}
            try { this.events.onEvent(frame.d.eventType, data) } catch (error) { console.error('obs: an event handler failed', error) }
          }
        } catch (error) {
          fail(error instanceof SyntaxError ? new Error('Invalid JSON from OBS') : error as Error)
        }
      })
    })
  }

  request(requestType: string, requestData: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.ready || !this.socket) return Promise.reject(new Error('OBS is disconnected'))
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        this.disconnect(new Error(`OBS ${requestType} timed out; outcome may be unknown. Inspect OBS before retrying`))
      }, this.timeoutMs)
      this.pending.set(requestId, { requestType, resolve, reject, timer })
      try { socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })) }
      catch { this.disconnect(new Error('OBS send failed; inspect OBS before retrying')) }
    })
  }

  disconnect(error = new Error('OBS disconnected')): void {
    const wasReady = this.ready
    this.ready = false
    const socket = this.socket
    this.socket = null
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    if (socket && socket.readyState < 2) socket.close()
    const events = this.events
    this.events = undefined
    if (wasReady && events) {
      try { events.onClose(error) } catch (err) { console.error('obs: a close handler failed', err) }
    }
  }
}
