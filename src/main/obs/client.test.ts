import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObsClient } from './client'

class Socket extends EventTarget {
  static last: Socket
  readyState = 1
  sent: Record<string, unknown>[] = []
  constructor() { super(); Socket.last = this }
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void { this.readyState = 3 }
  message(op: number, data: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op, d: data }) }))
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

async function connected(): Promise<{ client: ObsClient; socket: Socket }> {
  vi.stubGlobal('WebSocket', Socket)
  const client = new ObsClient(100)
  const connection = client.connect('ws://localhost:4455')
  const socket = Socket.last
  socket.message(0, { rpcVersion: 1 })
  socket.message(2, { negotiatedRpcVersion: 1 })
  await connection
  return { client, socket }
}

describe('OBS client lifecycle', () => {
  it('identifies and correlates out-of-order responses', async () => {
    const { client, socket } = await connected()
    expect(socket.sent[0]).toEqual({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } })
    const first = client.request('GetVersion')
    const second = client.request('GetRecordStatus')
    const firstData = socket.sent[1].d as Record<string, unknown>
    const secondData = socket.sent[2].d as Record<string, unknown>
    socket.message(7, { ...secondData, requestStatus: { result: true }, responseData: { outputActive: false } })
    socket.message(7, { ...firstData, requestStatus: { result: true }, responseData: { obsVersion: '32' } })
    await expect(first).resolves.toEqual({ obsVersion: '32' })
    await expect(second).resolves.toEqual({ outputActive: false })
    client.disconnect()
  })

  it('times out and rejects all pending requests without retrying writes', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connected()
    const first = expect(client.request('StartRecord')).rejects.toThrow('outcome may be unknown')
    const second = expect(client.request('GetRecordStatus')).rejects.toThrow('outcome may be unknown')
    await vi.advanceTimersByTimeAsync(101)
    await first
    await second
    expect(socket.readyState).toBe(3)
    expect(socket.sent).toHaveLength(3)
    await expect(client.request('StopRecord')).rejects.toThrow('disconnected')
  })

  it('times out identification and reports authentication disconnect codes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', Socket)
    const client = new ObsClient(100)
    const timeout = expect(client.connect('ws://localhost:4455')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(101)
    await timeout
    const next = new ObsClient(100)
    const rejected = expect(next.connect('ws://localhost:4455')).rejects.toThrow('4009')
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: 4009 })
    Socket.last.dispatchEvent(event)
    await rejected
  })
})
