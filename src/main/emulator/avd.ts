import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { avdHome } from './sdk'

// one phone per brand, named after the brand id so it can't clash
export function avdName(brandId: string): string {
  return `trenddeck-${brandId}`
}

function avdDir(brandId: string): string {
  return join(avdHome(), `${avdName(brandId)}.avd`)
}

export function avdExists(brandId: string): boolean {
  return existsSync(join(avdHome(), `${avdName(brandId)}.ini`))
}

// a small phone screen keeps screen grabs quick
const WIDTH = 720
const HEIGHT = 1520
const DENSITY = 320

// written by hand so nobody needs java for avdmanager. rewritten on every start so it
// follows the sdk if that moves, the phone's data lives in other files and is kept
export async function writeAvd(brandId: string, brandName: string, image: string): Promise<void> {
  const name = avdName(brandId)
  const dir = avdDir(brandId)
  const abi = image.split('/').pop() as string
  const level = image.split('/')[1]
  await fs.mkdir(dir, { recursive: true })
  const ini = [
    'avd.ini.encoding=UTF-8',
    `path=${dir}`,
    `path.rel=avd/${name}.avd`,
    `target=${level}`
  ]
  await fs.writeFile(join(avdHome(), `${name}.ini`), ini.join('\n') + '\n')
  const config: Record<string, string> = {
    AvdId: name,
    'avd.ini.displayname': `TrendDeck ${brandName.replace(/[\r\n]/g, ' ').slice(0, 40)}`,
    'avd.ini.encoding': 'UTF-8',
    'abi.type': abi,
    'hw.cpu.arch': abi.startsWith('arm') ? 'arm64' : 'x86_64',
    'hw.cpu.ncore': '4',
    'hw.ramSize': '3072',
    'vm.heapSize': '256',
    'image.sysdir.1': `${image}/`,
    'tag.id': 'google_apis_playstore',
    'tag.display': 'Google Play',
    'PlayStore.enabled': 'true',
    'hw.lcd.width': String(WIDTH),
    'hw.lcd.height': String(HEIGHT),
    'hw.lcd.density': String(DENSITY),
    'hw.keyboard': 'yes',
    'hw.mainKeys': 'no',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'swiftshader_indirect',
    'hw.audioInput': 'no',
    'hw.audioOutput': 'no',
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    'hw.sdCard': 'no',
    'disk.dataPartition.size': '6G',
    'fastboot.forceColdBoot': 'no',
    'showDeviceFrame': 'no'
  }
  const text = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  await fs.writeFile(join(dir, 'config.ini'), text)
}

export async function deleteAvd(brandId: string): Promise<void> {
  await fs.rm(avdDir(brandId), { recursive: true, force: true })
  await fs.rm(join(avdHome(), `${avdName(brandId)}.ini`), { force: true })
}
