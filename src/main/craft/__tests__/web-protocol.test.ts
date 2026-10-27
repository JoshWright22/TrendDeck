import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { craftWebResponse, projectUrl, type WebProtocolDeps } from '../web-protocol'

let base: string
let build: string
let folder: string
// made per run like main makes one per card
const TOKEN = randomBytes(16).toString('hex')
let deps: WebProtocolDeps

beforeAll(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'craft-web-protocol-'))
  build = join(base, 'build')
  folder = join(base, 'Ep 1')
  await fs.mkdir(join(build, 'app'), { recursive: true })
  await fs.mkdir(join(folder, 'media'), { recursive: true })
  await fs.writeFile(join(build, 'index.html'), '<!doctype html>')
  await fs.writeFile(join(build, 'filmcraft_web_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
  await fs.writeFile(join(base, 'secret.txt'), 'not for the page')
  await fs.writeFile(join(folder, 'media', 'clip one.mp4'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
  deps = {
    appRoot: async (appId) => (appId === 'filmcraft' ? build : null),
    projectRoot: (appId, token) => (appId === 'filmcraft' && token === TOKEN ? folder : null)
  }
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

const get = (url: string, range: string | null = null, method = 'GET'): Promise<Response> => craftWebResponse(url, method, range, deps)

describe('craft-web: the app build', () => {
  it('serves index.html at the root with the isolation headers', async () => {
    const r = await get('craft-web://filmcraft/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/^text\/html/)
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'")
    expect(await r.text()).toBe('<!doctype html>')
  })

  it('serves wasm as application/wasm', async () => {
    const r = await get('craft-web://filmcraft/filmcraft_web_bg.wasm?v=abc')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/wasm')
    expect(r.headers.get('content-length')).toBe('4')
  })

  it('refuses anything outside the build, other apps and other methods', async () => {
    expect((await get('craft-web://filmcraft/%2e%2e/secret.txt')).status).toBe(404)
    expect((await get('craft-web://filmcraft/app')).status).toBe(404)
    expect((await get('craft-web://filmcraft/missing.js')).status).toBe(404)
    expect((await get('craft-web://soundcraft/index.html')).status).toBe(404)
    expect((await get('craft-web://filmcraft/index.html', null, 'POST')).status).toBe(405)
  })
})

describe('craft-web: project files', () => {
  it('serves a project file by token, read only, whole or in ranges', async () => {
    const url = projectUrl('filmcraft', TOKEN, 'media/clip one.mp4')
    const whole = await get(url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('cache-control')).toBe('no-store')
    expect((await whole.arrayBuffer()).byteLength).toBe(1000)

    const part = await get(url, 'bytes=10-19')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect(part.headers.get('content-length')).toBe('10')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

    const tail = await get(url, 'bytes=-5')
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 995-999/1000')

    const past = await get(url, 'bytes=2000-')
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */1000')

    const head = await get(url, null, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('1000')
    expect(head.body).toBeNull()
  })

  it('refuses unknown tokens, climbing out and folders', async () => {
    expect((await get(projectUrl('filmcraft', 'f'.repeat(32), 'media/clip one.mp4'))).status).toBe(404)
    expect((await get(projectUrl('photocraft', TOKEN, 'media/clip one.mp4'))).status).toBe(404)
    expect((await get(`craft-web://filmcraft/_project/${TOKEN}/%2e%2e/secret.txt`)).status).toBe(404)
    expect((await get(`craft-web://filmcraft/_project/${TOKEN}/media`)).status).toBe(404)
  })

  it('refuses a link that leads out of the folder', async () => {
    const link = join(folder, 'media', 'out')
    try {
      await fs.symlink(base, link, 'junction')
    } catch {
      return // no links on this machine without rights, nothing to check
    }
    expect((await get(`craft-web://filmcraft/_project/${TOKEN}/media/out/secret.txt`)).status).toBe(404)
  })
})
