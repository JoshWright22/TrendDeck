import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SdkInfo, VirtCheck } from '@shared/emulator'

const isWin = process.platform === 'win32'
const exe = isWin ? '.exe' : ''

export const API_LEVEL = 34
export const IMAGE_TAG = 'google_apis_playstore'

// arm macs and arm linux need the arm image, everything else runs x86_64
export function imageAbi(): string {
  return process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
}

export function dataDir(): string {
  return join(app.getPath('userData'), 'android')
}

export function ownedSdk(): string {
  return join(dataDir(), 'sdk')
}

export function avdHome(): string {
  return join(dataDir(), 'avd')
}

export function emulatorBin(root: string): string {
  return join(root, 'emulator', `emulator${exe}`)
}

export function adbBin(root: string): string {
  return join(root, 'platform-tools', `adb${exe}`)
}

function avdmanagerBin(root: string): string | null {
  const name = isWin ? 'avdmanager.bat' : 'avdmanager'
  const options = [join(root, 'cmdline-tools', 'latest', 'bin', name), join(root, 'tools', 'bin', name)]
  return options.find((p) => existsSync(p)) ?? null
}

// sdk folders people usually have, in the order we try them
function externalRoots(): string[] {
  const home = homedir()
  const list = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (isWin) list.push(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  else if (process.platform === 'darwin') list.push(join(home, 'Library', 'Android', 'sdk'))
  else list.push(join(home, 'Android', 'Sdk'))
  return [...new Set(list.filter((p): p is string => !!p && existsSync(p)))]
}

// any play store image with the right cpu type, newest android first
function findImage(root: string): string | null {
  const abi = imageAbi()
  const base = join(root, 'system-images')
  if (!existsSync(base)) return null
  const wanted = `android-${API_LEVEL}`
  let levels: string[]
  try {
    levels = readdirSync(base)
  } catch {
    return null
  }
  levels.sort((a, b) => {
    if (a === wanted) return -1
    if (b === wanted) return 1
    return (parseInt(b.replace(/\D+/g, '')) || 0) - (parseInt(a.replace(/\D+/g, '')) || 0)
  })
  for (const level of levels) {
    const dir = join(base, level, IMAGE_TAG, abi)
    if (existsSync(join(dir, 'system.img'))) return `system-images/${level}/${IMAGE_TAG}/${abi}`
  }
  return null
}

function inspect(root: string, owned: boolean): SdkInfo {
  return {
    root,
    owned,
    emulator: existsSync(emulatorBin(root)),
    adb: existsSync(adbBin(root)),
    avdmanager: avdmanagerBin(root) !== null,
    image: findImage(root)
  }
}

export function isComplete(info: SdkInfo): boolean {
  return info.emulator && info.adb && info.image !== null
}

// our own copy wins, then any complete sdk already on the machine, then whatever partial one we saw
export function findSdk(): SdkInfo {
  const own = inspect(ownedSdk(), true)
  if (isComplete(own)) return own
  const others = externalRoots().map((r) => inspect(r, false))
  const complete = others.find(isComplete)
  if (complete) return complete
  if (own.emulator || own.adb || own.image) return own
  return others[0] ?? { root: null, owned: false, emulator: false, adb: false, avdmanager: false, image: null }
}

export function run(
  file: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout ?? 30000, env: opts.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` })
      }
    )
  })
}

export function sdkEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    ANDROID_AVD_HOME: avdHome()
  }
}

let virtCache: VirtCheck | null = null

const BIOS_OFF =
  "Hardware virtualization is off. Restart your computer, open the BIOS/UEFI setup and turn on Intel VT-x or AMD-V (sometimes called SVM), then open TrendDeck again."

async function windowsCheck(): Promise<VirtCheck> {
  const aehd = await run('sc.exe', ['query', 'aehd'], { timeout: 5000 })
  if (aehd.code === 0 && /RUNNING/.test(aehd.out)) {
    return { ok: true, detail: 'The Android hypervisor driver is running.' }
  }
  const ps = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p = Get-CimInstance Win32_Processor | Select-Object -First 1; $c = Get-CimInstance Win32_ComputerSystem; "$($p.VirtualizationFirmwareEnabled) $($c.HypervisorPresent)"'
    ],
    { timeout: 15000 }
  )
  const [firmware, hypervisor] = ps.out.trim().split(/\s+/)
  // with hyper-v running windows reports the firmware flag as off, so check this first
  if (hypervisor === 'True') {
    return {
      ok: null,
      detail:
        'Windows is running its own hypervisor. The emulator needs "Windows Hypervisor Platform" turned on in Windows Features. It gets checked again after setup.'
    }
  }
  if (firmware === 'True') {
    return {
      ok: false,
      detail:
        'Virtualization is on in your BIOS but Windows isn\'t using it. Open "Turn Windows features on or off", tick "Windows Hypervisor Platform", restart, then try again.'
    }
  }
  if (firmware === 'False') return { ok: false, detail: BIOS_OFF }
  return { ok: null, detail: "Couldn't tell if virtualization is on. It gets checked again after setup." }
}

async function linuxCheck(): Promise<VirtCheck> {
  if (!existsSync('/dev/kvm')) return { ok: false, detail: `${BIOS_OFF} If it's on already, install KVM for your distro.` }
  try {
    await fs.access('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
    return { ok: true, detail: 'KVM is ready.' }
  } catch {
    return {
      ok: false,
      detail: 'KVM is installed but your user can\'t use it. Add yourself to the kvm group (sudo usermod -aG kvm $USER), log out and back in.'
    }
  }
}

async function macCheck(): Promise<VirtCheck> {
  const r = await run('sysctl', ['-n', 'kern.hv_support'], { timeout: 5000 })
  if (r.out.trim() === '1') return { ok: true, detail: 'This Mac supports virtualization.' }
  return { ok: false, detail: "This Mac doesn't support hardware virtualization, so the emulator can't run on it." }
}

// once the emulator is installed it can answer for itself, that answer is the one that counts
async function emulatorCheck(root: string): Promise<VirtCheck | null> {
  const r = await run(emulatorBin(root), ['-accel-check'], { timeout: 20000, env: sdkEnv(root) })
  const text = r.out.replace(/accel:\s*/g, '').replace(/\r/g, '').trim()
  if (!text) return null
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d+$/.test(l))
  const line = lines.find((l) => /usable|not|disabled|install|requires/i.test(l)) ?? lines[0] ?? ''
  if (r.code === 0) return { ok: true, detail: line || 'Hardware acceleration works.' }
  if (isWin) {
    const base = await windowsCheck()
    if (base.ok === false) return base
  }
  return { ok: false, detail: `The emulator can't use hardware acceleration: ${line}` }
}

export async function checkVirt(sdk: SdkInfo, fresh = false): Promise<VirtCheck> {
  if (virtCache && !fresh) return virtCache
  let result: VirtCheck | null = null
  if (sdk.root && sdk.emulator) result = await emulatorCheck(sdk.root)
  if (!result) {
    if (isWin) result = await windowsCheck()
    else if (process.platform === 'darwin') result = await macCheck()
    else result = await linuxCheck()
  }
  virtCache = result
  return result
}

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const s = await fs.statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}
