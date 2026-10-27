import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[], cursor: 0,
  effects: [] as (() => void)[], cleanups: [] as (() => void)[]
}))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = initial
    return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = value }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = { current: initial }
    return hooks.cells[index]
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.cells[index] as unknown[] | undefined
    if (previous && deps.every((dep, position) => dep === previous[position])) return
    hooks.cells[index] = deps
    hooks.effects.push(() => {
      hooks.cleanups[index]?.()
      hooks.cleanups[index] = effect() || (() => {})
    })
  }
}))

import TakeRecorder from './TakeRecorder'

interface ElementProps {
  children?: unknown
  onClick?: () => unknown
  onChange?: (event: { target: { value: string } }) => void
  role?: string
}
type Element = ReactElement<ElementProps>

class FakeRecorder {
  static last: FakeRecorder
  static isTypeSupported = (): boolean => true
  mimeType: string
  state = 'inactive'
  onstart: (() => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  constructor(_stream: unknown, options: { mimeType: string }) {
    this.mimeType = options.mimeType
    FakeRecorder.last = this
  }
  start(): void { this.state = 'recording'; this.onstart?.() }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['take'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

const track = { stop: vi.fn(), onended: null as (() => void) | null }
const stream = { getTracks: () => [track] }
const media = { saveRecording: vi.fn(), list: vi.fn() }
const getUserMedia = vi.fn()
const attach = vi.fn()
let tree: Element

function render(): void {
  hooks.cursor = 0
  const outer = TakeRecorder({ brandId: 'brand-a', onAttach: attach }) as ReactElement
  tree = (outer.type as (props: unknown) => Element)(outer.props)
  hooks.effects.splice(0).forEach((effect) => effect())
}

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

function click(text: string): unknown {
  const button = elements(tree).find((element) => element.type === 'button' && element.props.children === text)
  expect(button, text).toBeDefined()
  return button!.props.onClick!()
}

async function settle(): Promise<void> {
  for (let iteration = 0; iteration < 12; iteration++) await Promise.resolve()
  render()
}

function unmount(): void {
  hooks.cleanups.forEach((cleanup) => cleanup?.())
}

beforeEach(() => {
  hooks.cells = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = []
  vi.clearAllMocks()
  track.onended = null
  getUserMedia.mockResolvedValue(stream)
  media.saveRecording.mockResolvedValue({ added: 1, skipped: 0, ids: ['media-a'] })
  media.list.mockResolvedValue([{ id: 'media-a', name: 'Voice take', kind: 'audio', ext: 'weba', size: 4 }])
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('window', { trenddeck: { media }, setInterval, clearInterval })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:take')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  render()
})
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('take recorder lifecycle', () => {
  it('requests devices only on explicit start, then stops, previews, saves and attaches library media', async () => {
    expect(getUserMedia).not.toHaveBeenCalled()
    click('Record take')
    await settle()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    click('Stop')
    render()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    click('Save & attach')
    await settle()
    expect(media.saveRecording).toHaveBeenCalledWith('brand-a', expect.any(String), 'audio/webm;codecs=opus', expect.any(ArrayBuffer))
    expect(attach).toHaveBeenCalledWith([{ id: 'media-a', name: 'Voice take.weba', type: 'audio/weba', size: 4, media: true }])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take')
  })

  it('stops late permission results after cancel without starting a recorder', async () => {
    const pending = deferred<typeof stream>()
    getUserMedia.mockReturnValue(pending.promise)
    click('Record take'); render(); click('Cancel'); render()
    pending.resolve(stream)
    await settle()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(media.saveRecording).not.toHaveBeenCalled()
  })

  it('requests camera and microphone only after choosing camera and starting', async () => {
    const select = elements(tree).find((element) => element.type === 'select')!
    select.props.onChange!({ target: { value: 'camera' } })
    render(); click('Record take'); await settle()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true })
    expect(FakeRecorder.last.mimeType).toBe('video/webm;codecs=vp8,opus')
    expect(elements(tree).some((element) => element.type === 'video')).toBe(true)
  })

  it('discards a preview without persisting it and revokes its URL', async () => {
    click('Record take'); await settle(); click('Stop'); render()
    click('Discard'); render()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take')
    expect(media.saveRecording).not.toHaveBeenCalled()
    expect(elements(tree).some((element) => element.type === 'audio')).toBe(false)
  })

  it('rejects an oversized take and stops all capture tracks', async () => {
    click('Record take'); await settle()
    const chunk = new Blob(['too large'])
    Object.defineProperty(chunk, 'size', { value: 250_000_001 })
    FakeRecorder.last.ondataavailable?.({ data: chunk })
    render()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(elements(tree).find((element) => element.props.role === 'alert')?.props.children).toContain('250 MB')
    expect(media.saveRecording).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('stops tracks when unmounted during recording', async () => {
    click('Record take'); await settle()
    const current = FakeRecorder.last
    unmount()
    expect(current.state).toBe('inactive')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('ignores permission completion after unmount', async () => {
    const pending = deferred<typeof stream>()
    getUserMedia.mockReturnValue(pending.promise)
    click('Record take'); unmount()
    pending.resolve(stream)
    await settle()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(attach).not.toHaveBeenCalled()
  })

  it('does not attach a stale save result after unmount or brand replacement', async () => {
    const pending = deferred<{ added: number; skipped: number; ids: string[] }>()
    media.saveRecording.mockReturnValue(pending.promise)
    click('Record take'); await settle(); click('Stop'); render()
    click('Save & attach'); await settle()
    expect(media.saveRecording).toHaveBeenCalledOnce()
    unmount()
    pending.resolve({ added: 1, skipped: 0, ids: ['media-a'] })
    await settle()
    expect(attach).not.toHaveBeenCalled()
    expect(media.list).not.toHaveBeenCalled()
  })

  it('retries attachment without saving the same take twice', async () => {
    media.list.mockRejectedValueOnce(new Error('Temporary listing failure'))
    click('Record take'); await settle(); click('Stop'); render()
    click('Save & attach'); await settle()
    click('Retry attach'); await settle()
    expect(media.saveRecording).toHaveBeenCalledOnce()
    expect(attach).toHaveBeenCalledOnce()
  })

  it('brand changes replace the entire recorder lifecycle', () => {
    const first = TakeRecorder({ brandId: 'brand-a', onAttach: attach }) as ReactElement
    const second = TakeRecorder({ brandId: 'brand-b', onAttach: attach }) as ReactElement
    expect(first.key).not.toBe(second.key)
  })
})
