import { spawn, type ChildProcess } from 'node:child_process'
import type { PhoneFrame, PhoneInput, PhoneKey, PhoneState, PhoneStatus } from '@shared/emulator'
import { avdExists, avdName, deleteAvd, writeAvd } from './avd'
import { adbBin, checkVirt, emulatorBin, findSdk, isComplete, run, sdkEnv } from './sdk'

interface Phone {
  brandId: string
  state: PhoneState
  message: string | null
  root: string
  serial: string
  proc: ChildProcess | null
  shell: ChildProcess | null
  watch: NodeJS.Timeout | null
  log: string[]
}

const phones = new Map<string, Phone>()
let notify: (s: PhoneStatus) => void = () => {}

export function onPhoneChange(fn: (s: PhoneStatus) => void): void {
  notify = fn
}

export function phoneStatus(brandId: string): PhoneStatus {
  const p = phones.get(brandId)
  return {
    brandId,
    state: p?.state ?? 'off',
    created: avdExists(brandId),
    message: p?.message ?? null
  }
}

function setState(p: Phone, state: PhoneState, message: string | null = null): void {
  p.state = state
  p.message = message
  notify(phoneStatus(p.brandId))
}

function adb(p: Phone, args: string[], timeout = 30000): Promise<{ code: number; out: string }> {
  return run(adbBin(p.root), ['-s', p.serial, ...args], { timeout, env: sdkEnv(p.root) })
}

// emulators take an even console port from 5554 up, the serial is emulator-<port>
async function freePort(root: string): Promise<number> {
  const used = new Set([...phones.values()].map((p) => p.serial))
  const list = await run(adbBin(root), ['devices'], { timeout: 15000, env: sdkEnv(root) })
  for (const m of list.out.matchAll(/emulator-(\d+)/g)) used.add(`emulator-${m[1]}`)
  for (let port = 5554; port <= 5680; port += 2) {
    if (!used.has(`emulator-${port}`)) return port
  }
  throw new Error('Too many phones running')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// first boot of a new phone sets up android and can take several minutes
const BOOT_LIMIT = 10 * 60 * 1000

async function waitForBoot(p: Phone): Promise<void> {
  const until = Date.now() + BOOT_LIMIT
  let offlineSince = 0
  while (Date.now() < until) {
    if (p.state !== 'starting' && p.state !== 'booting') return
    const r = await adb(p, ['shell', 'getprop', 'sys.boot_completed'], 10000)
    if (r.code === 0 && r.out.trim() === '1') {
      // a sleeping screen is black and screenrecord sends nothing, so keep it awake
      await adb(p, ['shell', 'svc power stayon true; input keyevent 224'], 15000)
      if (p.state === 'starting' || p.state === 'booting') setState(p, 'on')
      return
    }
    const seen = r.code === 0 || (await listed(p))
    if (p.state === 'starting' && seen) setState(p, 'booting')
    // adb sometimes never finishes connecting to a new emulator, reconnecting fixes it
    if (seen && /offline/.test(r.out)) {
      if (!offlineSince) offlineSince = Date.now()
      else if (Date.now() - offlineSince > 45000) {
        await run(adbBin(p.root), ['reconnect', 'offline'], { timeout: 15000, env: sdkEnv(p.root) })
        offlineSince = Date.now()
      }
    } else offlineSince = 0
    await sleep(2000)
  }
  if (p.state !== 'starting' && p.state !== 'booting') return
  await killQemu(p)
  ended(p, 'The phone took more than 10 minutes to start')
}

const live = (s: PhoneState): boolean => s === 'starting' || s === 'booting' || s === 'on' || s === 'stopping'

// adb lists the phone from early in boot until it's gone, offline or not
async function listed(p: Phone): Promise<boolean> {
  const r = await run(adbBin(p.root), ['devices'], { timeout: 10000, env: sdkEnv(p.root) })
  return r.out.split(/\r?\n/).some((line) => line.split(/\s+/)[0] === p.serial)
}

function ended(p: Phone, why: string | null): void {
  if (p.watch) clearInterval(p.watch)
  p.watch = null
  stopStream(p.brandId)
  p.shell?.kill()
  p.shell = null
  if (p.state === 'stopping' || p.state === 'off' || !why) setState(p, 'off')
  else setState(p, 'error', why)
}

function lastError(p: Phone): string {
  const line = [...p.log].reverse().find((l) => /fatal|error|panic|fail/i.test(l)) ?? p.log.at(-1) ?? ''
  return line.replace(/^(FATAL|ERROR|WARNING)\s*\|\s*/, '')
}

// on windows emulator.exe starts qemu and exits, so the phone is tracked through adb instead
function watch(p: Phone): void {
  let misses = 0
  p.watch = setInterval(() => {
    if (p.state !== 'booting' && p.state !== 'on') return
    void listed(p).then((ok) => {
      if (ok) misses = 0
      else if (++misses >= 3 && (p.state === 'booting' || p.state === 'on')) ended(p, 'The phone closed on its own')
    })
  }, 4000)
}

async function killQemu(p: Phone): Promise<void> {
  const name = avdName(p.brandId)
  p.proc?.kill()
  if (process.platform === 'win32') {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name like 'qemu-system%'" | Where-Object { $_.CommandLine -like '*-avd ${name} *' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
      ],
      { timeout: 15000 }
    )
  } else {
    await run('pkill', ['-f', `-avd ${name} `], { timeout: 5000 })
  }
}

export async function startPhone(brandId: string, brandName: string): Promise<void> {
  const current = phones.get(brandId)
  if (current && live(current.state)) return
  const sdk = findSdk()
  if (!sdk.root || !isComplete(sdk) || !sdk.image) throw new Error('Set up the phone first')
  const p: Phone = {
    brandId,
    state: 'starting',
    message: null,
    root: sdk.root,
    serial: '',
    proc: null,
    shell: null,
    watch: null,
    log: []
  }
  phones.set(brandId, p)
  setState(p, 'starting', 'Checking virtualization')
  try {
    const virt = await checkVirt(sdk)
    if (virt.ok === false) throw new Error(virt.detail)
    await writeAvd(brandId, brandName, sdk.image)
    const port = await freePort(sdk.root)
    p.serial = `emulator-${port}`
    setState(p, 'starting')
  } catch (e) {
    setState(p, 'error', (e as Error).message)
    return
  }
  const args = [
    '-avd', avdName(brandId),
    '-port', String(p.serial.slice('emulator-'.length)),
    '-no-window',
    '-no-audio',
    '-no-boot-anim',
    '-gpu', 'swiftshader_indirect',
    // keeps usage stats from going to google
    '-no-metrics'
  ]
  const proc = spawn(emulatorBin(sdk.root), args, { env: sdkEnv(sdk.root), windowsHide: true })
  p.proc = proc
  const keep = (d: Buffer): void => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (line.trim()) p.log.push(line.trim())
    }
    if (p.log.length > 60) p.log.splice(0, p.log.length - 60)
  }
  proc.stdout?.on('data', keep)
  proc.stderr?.on('data', keep)
  proc.on('error', (e) => ended(p, e.message))
  proc.on('exit', () => {
    if (p.proc === proc) p.proc = null
    if (!live(p.state) || p.state === 'stopping') return
    // the launcher leaving is fine as long as the phone itself shows up
    void sleep(3000)
      .then(() => listed(p))
      .then((ok) => {
        if (!ok && live(p.state) && p.state !== 'stopping') ended(p, `The emulator closed. ${lastError(p)}`.trim())
      })
  })
  watch(p)
  void waitForBoot(p)
}

export async function stopPhone(brandId: string): Promise<void> {
  const p = phones.get(brandId)
  if (!p || !live(p.state) || p.state === 'stopping') return
  if (!p.serial) return ended(p, null)
  setState(p, 'stopping')
  // a clean shutdown saves a quick boot snapshot, so the next start is fast
  await adb(p, ['emu', 'kill'], 15000)
  const until = Date.now() + 20000
  while (Date.now() < until && (await listed(p))) await sleep(500)
  if (await listed(p)) await killQemu(p)
  ended(p, null)
}

export async function stopAll(): Promise<void> {
  await Promise.all([...phones.keys()].map((id) => stopPhone(id).catch(() => {})))
}

export function anyRunning(): boolean {
  return [...phones.values()].some((p) => live(p.state))
}

function onPhone(brandId: string): Phone {
  const p = phones.get(brandId)
  if (!p || p.state !== 'on') throw new Error('The phone is off')
  return p
}

// raw screencap skips the png encode on the phone, which is the slow part
export function grabFrame(brandId: string): Promise<PhoneFrame | null> {
  const p = phones.get(brandId)
  if (!p || p.state !== 'on') return Promise.resolve(null)
  return new Promise((resolve) => {
    const proc = spawn(adbBin(p.root), ['-s', p.serial, 'exec-out', 'screencap'], {
      env: sdkEnv(p.root),
      windowsHide: true
    })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    const timer = setTimeout(() => proc.kill(), 15000)
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      clearTimeout(timer)
      const buf = Buffer.concat(chunks)
      if (buf.length < 16) return resolve(null)
      const width = buf.readUInt32LE(0)
      const height = buf.readUInt32LE(4)
      const size = width * height * 4
      // the header is 12 bytes on old android and 16 on newer, whatever is left over
      const header = buf.length - size
      if (!width || !height || header < 12 || header > 16) return resolve(null)
      resolve({ width, height, pixels: new Uint8Array(buf.buffer, buf.byteOffset + header, size) })
    })
  })
}

interface Stream {
  proc: ChildProcess | null
  wanted: boolean
}

const streams = new Map<string, Stream>()

// h264 straight from the phone's encoder, much smoother than screen grabs. screenrecord
// stops on its own after a few minutes so it gets restarted while the tab still wants it
export function startStream(brandId: string, send: (chunk: Uint8Array) => void, onEnd: () => void): void {
  stopStream(brandId)
  const p = onPhone(brandId)
  const s: Stream = { proc: null, wanted: true }
  streams.set(brandId, s)
  shellOf(p).stdin?.write('input keyevent 224\n')
  let starts = 0
  const launch = (): void => {
    if (!s.wanted || p.state !== 'on') return onEnd()
    // more than a few restarts in a row without data means it doesn't work here
    if (++starts > 4) return onEnd()
    const proc = spawn(
      adbBin(p.root),
      ['-s', p.serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', '6000000', '-'],
      { env: sdkEnv(p.root), windowsHide: true }
    )
    s.proc = proc
    proc.stdout.on('data', (d: Buffer) => {
      starts = 0
      send(new Uint8Array(d.buffer, d.byteOffset, d.length))
    })
    proc.stderr.resume()
    proc.on('error', () => {})
    proc.on('close', () => {
      if (s.proc === proc) s.proc = null
      if (s.wanted) setTimeout(launch, 300)
    })
  }
  launch()
}

export function stopStream(brandId: string): void {
  const s = streams.get(brandId)
  if (!s) return
  s.wanted = false
  s.proc?.kill()
  streams.delete(brandId)
  // killing adb here doesn't stop screenrecord on the phone, and a stuck one blocks the next
  const p = phones.get(brandId)
  if (p && p.state === 'on') void adb(p, ['shell', 'pkill', 'screenrecord'], 10000)
}

const KEYCODES: Record<PhoneKey, number> = {
  back: 4,
  home: 3,
  recents: 187,
  del: 67,
  enter: 66,
  tab: 61,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  power: 26
}

// one long lived shell per phone, a new adb process for every tap is too slow
function shellOf(p: Phone): ChildProcess {
  if (p.shell && p.shell.exitCode === null && !p.shell.killed) return p.shell
  const sh = spawn(adbBin(p.root), ['-s', p.serial, 'shell'], { env: sdkEnv(p.root), windowsHide: true })
  sh.stdout?.resume()
  sh.stderr?.resume()
  sh.on('error', () => {})
  sh.on('exit', () => {
    if (p.shell === sh) p.shell = null
  })
  p.shell = sh
  return sh
}

// single quotes keep the shell from touching anything, input text reads %s as a space
function quoteText(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '')
  return `'${clean.replace(/'/g, "'\\''").replace(/ /g, '%s')}'`
}

const int = (n: number): number => Math.max(0, Math.round(Number(n) || 0))

export function sendInput(brandId: string, input: PhoneInput): void {
  const p = onPhone(brandId)
  let cmd: string
  if (input.type === 'tap') cmd = `input tap ${int(input.x)} ${int(input.y)}`
  else if (input.type === 'swipe') {
    const ms = Math.min(int(input.ms), 3000)
    cmd = `input swipe ${int(input.x1)} ${int(input.y1)} ${int(input.x2)} ${int(input.y2)} ${ms}`
  } else if (input.type === 'key') {
    const code = KEYCODES[input.key]
    if (!code) return
    cmd = `input keyevent ${code}`
  } else if (input.type === 'text') {
    const q = quoteText(String(input.text).slice(0, 500))
    if (q === "''") return
    cmd = `input text ${q}`
  } else return
  shellOf(p).stdin?.write(`${cmd}\n`)
}

export async function installApk(brandId: string, file: string): Promise<string> {
  const p = onPhone(brandId)
  const r = await adb(p, ['install', '-r', file], 5 * 60 * 1000)
  if (r.code === 0 && /Success/.test(r.out)) return 'Installed'
  const why = /Failure \[([^\]]+)\]/.exec(r.out)?.[1] ?? r.out.trim().split('\n').pop() ?? 'unknown error'
  return `Install failed: ${why}`
}

export async function openPlayStore(brandId: string, pkg?: string): Promise<void> {
  const p = onPhone(brandId)
  if (pkg && /^[A-Za-z0-9_.]{1,150}$/.test(pkg)) {
    await adb(p, [
      'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
      '-d', `market://details?id=${pkg}`, '-p', 'com.android.vending'
    ])
    return
  }
  await adb(p, ['shell', 'monkey', '-p', 'com.android.vending', '-c', 'android.intent.category.LAUNCHER', '1'])
}

export async function wipePhone(brandId: string): Promise<void> {
  await stopPhone(brandId)
  phones.delete(brandId)
  await deleteAvd(brandId)
  notify(phoneStatus(brandId))
}

// adb keeps a server running after we quit, only stop it if it's ours
export async function stopAdbServer(): Promise<void> {
  const sdk = findSdk()
  if (sdk.owned && sdk.root && sdk.adb) {
    await run(adbBin(sdk.root), ['kill-server'], { timeout: 5000, env: sdkEnv(sdk.root) })
  }
}
