import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { SetupProgress } from '@shared/emulator'
import { API_LEVEL, IMAGE_TAG, imageAbi, ownedSdk } from './sdk'

const REPO = 'https://dl.google.com/android/repository/'
const MAIN_XML = `${REPO}repository2-3.xml`
const IMAGE_BASE = `${REPO}sys-img/${IMAGE_TAG}/`
const IMAGE_XML = `${IMAGE_BASE}sys-img2-3.xml`

// sizes from the current google list, only used before the real list is fetched
export const ESTIMATE_DOWNLOAD = 2_000_000_000
export const ESTIMATE_DISK = 4_500_000_000

interface Archive {
  name: string
  url: string
  size: number
  sha1: string
  // where the zip's top folder ends up, relative to the sdk root
  dest: string
}

function hostOs(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macosx'
  return 'linux'
}

function hostArch(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)
  return m ? m[1].trim() : null
}

// the stable entry of a package with an archive for this computer
function pickArchive(xml: string, path: string): Omit<Archive, 'name' | 'dest'> | null {
  const blocks = xml.split('<remotePackage ').slice(1)
  for (const block of blocks) {
    if (!block.startsWith(`path="${path}"`)) continue
    if (!block.includes('<channelRef ref="channel-0"/>')) continue
    for (const archive of block.split('<archive>').slice(1)) {
      const os = tag(archive, 'host-os')
      const arch = tag(archive, 'host-arch')
      if (os && os !== hostOs()) continue
      if (arch && arch !== hostArch()) continue
      const url = tag(archive, 'url')
      const size = Number(tag(archive, 'size'))
      const sha1 = /<checksum type="sha1">([0-9a-f]+)<\/checksum>/.exec(archive)?.[1]
      if (url && size && sha1) return { url, size, sha1 }
    }
  }
  return null
}

async function getText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Google's package list answered ${res.status}`)
  return res.text()
}

async function plan(signal: AbortSignal): Promise<Archive[]> {
  const [main, images] = await Promise.all([getText(MAIN_XML, signal), getText(IMAGE_XML, signal)])
  const image = `system-images;android-${API_LEVEL};${IMAGE_TAG};${imageAbi()}`
  const wanted: Array<[string, string, string, string]> = [
    ['Platform tools', 'platform-tools', main, ''],
    ['Emulator', 'emulator', main, ''],
    ['Android 14 with Play Store', image, images, IMAGE_BASE]
  ]
  const list: Archive[] = []
  for (const [name, path, xml, base] of wanted) {
    const a = pickArchive(xml, path)
    if (!a) throw new Error(`No ${name.toLowerCase()} download for this computer`)
    const dest = path.split(';').join('/')
    list.push({ name, dest, ...a, url: new URL(a.url, base || REPO).toString() })
  }
  return list
}

async function download(
  a: Archive,
  file: string,
  signal: AbortSignal,
  onBytes: (n: number) => void
): Promise<void> {
  const res = await fetch(a.url, { signal })
  if (!res.ok || !res.body) throw new Error(`${a.name} download failed (${res.status})`)
  const hash = createHash('sha1')
  const out = createWriteStream(file)
  const body = Readable.fromWeb(res.body as never)
  await new Promise<void>((resolve, reject) => {
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      onBytes(chunk.length)
      if (!out.write(chunk)) {
        body.pause()
        out.once('drain', () => body.resume())
      }
    })
    body.on('end', () => out.end(resolve))
    body.on('error', reject)
    out.on('error', reject)
  })
  if (hash.digest('hex') !== a.sha1) throw new Error(`${a.name} download was damaged, try again`)
}

function unzip(zip: string, into: string, signal: AbortSignal): Promise<void> {
  // windows 10 and newer ship bsdtar, which reads zips. the full path skips git's gnu tar
  const [cmd, args] =
    process.platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', into]]
      : ['unzip', ['-q', '-o', zip, '-d', into]]
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, signal })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', (e) =>
      reject(new Error(process.platform === 'win32' ? e.message : `Needs the unzip command: ${e.message}`))
    )
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unzip failed: ${err.trim().slice(0, 200)}`))))
  })
}

// zips hold one top folder, move it to where the emulator expects it
async function place(tmp: string, dest: string): Promise<void> {
  const entries = await fs.readdir(tmp)
  if (entries.length !== 1) throw new Error('Unexpected zip layout')
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(join(dest, '..'), { recursive: true })
  await fs.rename(join(tmp, entries[0]), dest)
}

let controller: AbortController | null = null
let progress: SetupProgress | null = null

export function setupProgress(): SetupProgress | null {
  return progress
}

let cancelled = false

export function cancelSetup(): void {
  if (!controller) return
  cancelled = true
  controller.abort()
}

export async function runSetup(send: (p: SetupProgress) => void): Promise<void> {
  if (controller) return
  controller = new AbortController()
  const signal = controller.signal
  const root = ownedSdk()
  const work = join(root, '.download')
  let last = 0
  const report = (p: Partial<SetupProgress>, force = true): void => {
    progress = { ...(progress as SetupProgress), ...p }
    const now = Date.now()
    if (force || now - last > 250) {
      last = now
      send(progress)
    }
  }
  progress = { running: true, step: "Getting Google's package list", done: 0, total: 0, error: null, finished: false }
  send(progress)
  try {
    await fs.mkdir(work, { recursive: true })
    const archives = await plan(signal)
    const todo = archives.filter((a) => !existsSync(join(root, a.dest, 'package.done')))
    const total = todo.reduce((n, a) => n + a.size, 0)
    let done = 0
    for (const a of todo) {
      const zip = join(work, a.url.split('/').pop() as string)
      report({ step: `Downloading ${a.name}`, done, total })
      await download(a, zip, signal, (n) => {
        done += n
        report({ done }, false)
      })
      report({ step: `Unpacking ${a.name}` })
      const tmp = join(work, 'unpack')
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.mkdir(tmp, { recursive: true })
      await unzip(zip, tmp, signal)
      await place(tmp, join(root, a.dest))
      await fs.rm(zip, { force: true })
      await fs.rm(tmp, { recursive: true, force: true })
      // marks a finished unpack so a cancelled setup can pick up where it stopped
      await fs.writeFile(join(root, a.dest, 'package.done'), a.url)
    }
    await fs.rm(work, { recursive: true, force: true })
    report({ running: false, step: 'Done', done: total, total, finished: true })
  } catch (e) {
    console.error('[emulator] setup failed', e)
    const msg = cancelled ? 'Setup cancelled' : (e as Error).message
    report({ running: false, step: 'Stopped', error: msg })
  } finally {
    controller = null
    cancelled = false
  }
}
