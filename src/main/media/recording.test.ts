import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AddResult } from '@shared/media'

const mocks = vi.hoisted(() => ({
  root: '', brandId: '', activeBrandId: '', exists: true,
  handlers: new Map<string, (...args: unknown[]) => Promise<AddResult>>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  BrowserWindow: {}, dialog: {}, shell: {},
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<AddResult>) => mocks.handlers.set(name, handler) }
}))
vi.mock('../store', () => ({ getData: () => ({
  activeBrandId: mocks.activeBrandId,
  brands: mocks.exists ? [{ id: mocks.brandId }] : []
}) }))
vi.mock('./protocol', () => ({ registerMediaScheme: vi.fn(), handleMediaScheme: vi.fn() }))
vi.mock('./watch', () => ({
  addWatch: vi.fn(), editWatch: vi.fn(), removeWatch: vi.fn(), startAllWatches: vi.fn(), stopBrandWatches: vi.fn()
}))

import { setupMedia } from './index'
import { brandDir, getLib } from './library'

const event = { sender: { getType: () => 'window' } }
const bytes = new Uint8Array([1, 2, 3, 4]).buffer
const save = (name: unknown = 'My take', mime: unknown = 'audio/webm;codecs=opus', data: unknown = bytes): Promise<AddResult> =>
  mocks.handlers.get('media:save-recording')!(event, mocks.brandId, name, mime, data)

beforeAll(async () => {
  mocks.root = await fs.mkdtemp(join(tmpdir(), 'trenddeck-recording-'))
  setupMedia()
})
beforeEach(() => {
  mocks.brandId = randomUUID()
  mocks.activeBrandId = mocks.brandId
  mocks.exists = true
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await fs.rm(mocks.root, { recursive: true, force: true }) })

describe('recording persistence', () => {
  it.each([
    ['audio/webm;codecs=opus', 'weba', 'audio'],
    ['video/webm;codecs=vp8,opus', 'webm', 'video'],
    ['audio/mp4', 'm4a', 'audio'],
    ['video/mp4', 'mp4', 'video'],
    ['audio/ogg;codecs=opus', 'ogg', 'audio']
  ])('saves %s inside the brand library as copied media', async (mime, ext, kind) => {
    const result = await save('../../unsafe/name', mime)
    expect(result).toMatchObject({ added: 1, skipped: 0 })
    const item = (await getLib(mocks.brandId)).items[0]
    expect(item).toMatchObject({ id: result.ids[0], ext, kind, copied: true, size: 4 })
    expect(item.path).toBe(join(brandDir(mocks.brandId), 'files', basename(item.path)))
    expect(basename(item.path)).toMatch(new RegExp(`^[a-f0-9-]+\\.${ext}$`))
    expect(item.name).not.toMatch(/[/\\]/)
    expect(await fs.readFile(item.path)).toEqual(Buffer.from(bytes))
    const stored = JSON.parse(await fs.readFile(join(mocks.root, 'media', `${mocks.brandId}.json`), 'utf8'))
    expect(stored.items[0].id).toBe(item.id)
  })

  it('refuses webview senders and malformed brand ids', async () => {
    const handler = mocks.handlers.get('media:save-recording')!
    await expect(handler({ sender: { getType: () => 'webview' } }, mocks.brandId, 'take', 'audio/webm', bytes)).rejects.toThrow('bad media call')
    await expect(handler(event, '../escape', 'take', 'audio/webm', bytes)).rejects.toThrow('bad media call')
  })

  it('refuses missing and inactive brands', async () => {
    mocks.exists = false
    await expect(save()).rejects.toThrow('no longer active')
    mocks.exists = true
    mocks.activeBrandId = randomUUID()
    await expect(save()).rejects.toThrow('no longer active')
  })

  it.each(['image/png', 'text/html', 'application/octet-stream', '__proto__', 42])('refuses unsupported MIME %s', async (mime) => {
    await expect(save('take', mime)).rejects.toThrow('Unsupported recording type')
  })

  it('refuses empty, non-ArrayBuffer, and oversized payloads', async () => {
    await expect(save('take', 'audio/webm', new ArrayBuffer(0))).rejects.toThrow('250 MB')
    await expect(save('take', 'audio/webm', new Uint8Array(4))).rejects.toThrow('250 MB')
    const oversized = new ArrayBuffer(1)
    Object.defineProperty(oversized, 'byteLength', { value: 250_000_001 })
    await expect(save('take', 'audio/webm', oversized)).rejects.toThrow('250 MB')
  })

  it.each(['', '   ', 'a'.repeat(201), 123])('rejects invalid recording names', async (name) => {
    await expect(save(name)).rejects.toThrow('Invalid recording name')
  })

  it('removes a partial file when the write fails', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args)
      vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
      return file
    })
    await expect(save()).rejects.toThrow('disk full')
    expect((await getLib(mocks.brandId)).items).toEqual([])
    expect(await fs.readdir(join(brandDir(mocks.brandId), 'files'))).toEqual([])
  })

  it('rolls back the file and in-memory entry if library persistence fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('library disk full'))
    await expect(save()).rejects.toThrow('library disk full')
    expect((await getLib(mocks.brandId)).items).toEqual([])
    expect(await fs.readdir(join(brandDir(mocks.brandId), 'files'))).toEqual([])
    await expect(save()).resolves.toMatchObject({ added: 1 })
    expect((await getLib(mocks.brandId)).items).toHaveLength(1)
  })

  it('cleans up if the brand changes while bytes are written', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args)
      mocks.activeBrandId = randomUUID()
      return file
    })
    await expect(save()).rejects.toThrow('no longer active')
    expect((await getLib(mocks.brandId)).items).toEqual([])
    expect(await fs.readdir(join(brandDir(mocks.brandId), 'files'))).toEqual([])
  })
})
