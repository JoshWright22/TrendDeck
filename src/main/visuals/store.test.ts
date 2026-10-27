import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ccLicense, type VisualProvenance, type VisualResult } from '@shared/visuals'
import {
  addPick,
  assetPath,
  creditsText,
  decodeDataUrl,
  imageInfo,
  provenanceFromAsset,
  provenanceFromResult,
  readAsset,
  readCredits,
  rememberResults,
  findResult,
  saveAsset,
  servedVisual,
  takePicks,
  writeToProject
} from './store'

// a 2x3 png, made by hand: signature, IHDR, IDAT, IEND (crc values don't matter to the reader)
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(45)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the size
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)])
}

const RESULT: VisualResult = {
  id: 'wikimedia:222',
  provider: 'wikimedia',
  kind: 'image',
  title: 'Vulpes vulpes in snow',
  author: 'Some One',
  authorUrl: '',
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Vulpes.jpg',
  fileUrl: 'https://upload.wikimedia.org/Vulpes.jpg',
  thumbUrl: 'https://upload.wikimedia.org/thumb/Vulpes.jpg',
  thumb: '',
  width: 4000,
  height: 2667,
  duration: null,
  bytes: 1000,
  ext: 'jpg',
  license: ccLicense('by-sa', '4.0', 'https://creativecommons.org/licenses/by-sa/4.0'),
  attribution: ''
}

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'td-visuals-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('image headers', () => {
  it('reads png, jpeg, gif and webp sizes', () => {
    expect(imageInfo(png(2, 3))).toEqual({ mime: 'image/png', ext: 'png', width: 2, height: 3 })
    expect(imageInfo(jpeg(640, 480))).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 })
    const gif = Buffer.from('GIF89a\x10\x00\x20\x00\x00', 'latin1')
    expect(imageInfo(gif)).toMatchObject({ ext: 'gif', width: 16, height: 32 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp.writeUIntLE(99, 24, 3)
    webp.writeUIntLE(49, 27, 3)
    expect(imageInfo(webp)).toMatchObject({ ext: 'webp', width: 100, height: 50 })
    expect(imageInfo(Buffer.from('<html>'))).toBeNull()
  })

  it('only takes image data urls', () => {
    expect(decodeDataUrl(`data:image/png;base64,${png(1, 1).toString('base64')}`).length).toBe(45)
    expect(() => decodeDataUrl('data:text/html;base64,PGI+')).toThrow(/png, jpeg/)
  })
})

describe('assets', () => {
  it('saves and reads a sketch, and serves only known names', async () => {
    const a = await saveAsset(dir, 'brand-1', png(1280, 720), { origin: 'sketch', name: 'Sketch: <bad>/name', note: 'arrow here', sourceUrl: '', source: null })
    expect(a).toMatchObject({ brandId: 'brand-1', origin: 'sketch', mime: 'image/png', ext: 'png', width: 1280, height: 720, bytes: 45 })
    expect(a.name).not.toMatch(/[<>/:]/)
    expect(await readAsset(dir, 'brand-1', a.id)).toEqual(a)
    expect(await readAsset(dir, 'brand-2', a.id)).toBeNull()
    expect(await readAsset(dir, 'brand-1', '../x')).toBeNull()
    expect((await fs.stat(assetPath(dir, a))).size).toBe(45)
    expect(servedVisual(dir, 'brand-1', `items/${a.id}.png`)?.path).toBe(assetPath(dir, a))
    expect(servedVisual(dir, 'brand-1', `../items/${a.id}.png`)).toBeNull()
    expect(servedVisual(dir, 'brand-1', 'items/x.exe')).toBeNull()
    expect(servedVisual(dir, '..', 'items/x.png')).toBeNull()
  })

  it('refuses what is not an image', async () => {
    await expect(saveAsset(dir, 'brand-1', Buffer.from('hello'), { origin: 'paste', name: '', note: '', sourceUrl: '', source: null })).rejects.toThrow(/isn't an image/)
  })
})

describe('the project folder', () => {
  it('writes a downloaded option with its credit sidecar, once', async () => {
    const project = join(dir, 'Project')
    const first = await writeToProject(project, { bytes: jpeg(10, 10), ext: 'jpg', stem: RESULT.title, provenance: provenanceFromResult(RESULT) })
    expect(first.file).toBe('media/visuals/vulpes-vulpes-in-snow.jpg')
    expect(first.sidecar).toBe('media/visuals/vulpes-vulpes-in-snow.jpg.credit.json')
    expect(first.existed).toBe(false)
    const side = JSON.parse(await fs.readFile(join(project, first.sidecar), 'utf8')) as VisualProvenance
    expect(side).toMatchObject({
      version: 1,
      file: first.file,
      origin: 'search',
      provider: 'wikimedia',
      title: RESULT.title,
      author: 'Some One',
      sourceUrl: RESULT.pageUrl,
      fileUrl: RESULT.fileUrl,
      license: { name: 'CC BY-SA 4.0', attribution: true }
    })
    expect(Date.parse(side.retrievedAt)).toBeGreaterThan(0)
    // the same option again stays one file
    const again = await writeToProject(project, { bytes: jpeg(10, 10), ext: 'jpg', stem: RESULT.title, provenance: provenanceFromResult(RESULT) })
    expect(again).toMatchObject({ file: first.file, existed: true })
    // another file with the same name gets its own
    const other = await writeToProject(project, { bytes: jpeg(10, 10), ext: 'jpg', stem: RESULT.title, provenance: { ...provenanceFromResult(RESULT), fileUrl: 'https://upload.wikimedia.org/other.jpg' } })
    expect(other.file).toBe('media/visuals/vulpes-vulpes-in-snow-2.jpg')
  })

  it('sketches get a sidecar too, and credits list what needs it', async () => {
    const project = join(dir, 'Project')
    const a = await saveAsset(dir, 'brand-1', png(4, 4), { origin: 'sketch', name: 'Sketch', note: 'Drawn on a blank page.', sourceUrl: '', source: null })
    const s = await writeToProject(project, { bytes: png(4, 4), ext: 'png', stem: 'sketch-1', provenance: provenanceFromAsset(a) })
    expect(s.provenance).toMatchObject({ origin: 'sketch', author: 'you, drawn in TrendDeck', license: null })
    await writeToProject(project, { bytes: jpeg(10, 10), ext: 'jpg', stem: RESULT.title, provenance: provenanceFromResult(RESULT) })
    const credits = await readCredits(project)
    expect(credits.map((c) => c.origin).sort()).toEqual(['search', 'sketch'])
    const text = creditsText(credits)
    expect(text.split('\n')).toEqual([
      'Credits:',
      '- "Vulpes vulpes in snow" by Some One from Wikimedia Commons (https://commons.wikimedia.org/wiki/File:Vulpes.jpg), CC BY-SA 4.0 https://creativecommons.org/licenses/by-sa/4.0'
    ])
  })
})

describe('results and picks', () => {
  it('remembers recent results for card actions', async () => {
    await rememberResults(dir, 'brand-1', [RESULT])
    expect(await findResult(dir, 'brand-1', 'wikimedia:222')).toEqual(RESULT)
    expect(await findResult(dir, 'brand-1', 'pexels:1')).toBeNull()
  })

  it('picks are told once per thread', async () => {
    await addPick(dir, 'brand-1', 'thread-a', 'The user added  a sketch to the video files.')
    await addPick(dir, 'brand-1', 'thread-b', 'other')
    expect(await takePicks(dir, 'brand-1', 'thread-a')).toEqual(['The user added a sketch to the video files.'])
    expect(await takePicks(dir, 'brand-1', 'thread-a')).toEqual([])
    expect(await takePicks(dir, 'brand-1', 'thread-b')).toEqual(['other'])
  })
})
