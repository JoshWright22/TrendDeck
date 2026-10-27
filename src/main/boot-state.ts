// what boot.ts and the updater share about downloaded app code. no side effects in here,
// both the launcher and the app code it starts import it
import { app } from 'electron'
import { join } from 'node:path'
import fs from 'original-fs'

// bump when boot.ts changes in a way downloaded code depends on
export const BOOT_PROTOCOL = 1
// a downloaded version that fails to open the window this many launches in a row is dropped
export const MAX_TRIES = 2

export interface BootState {
  version: string
  // the downloaded .asar
  file: string
  // the shell it was made for, see shell.json
  shell: string
  tries: number
}

export interface BootInfo {
  bundledVersion: string
  // the version running, the downloaded one or the bundled one
  version: string
  hot: boolean
  shell: string
  markGood(): void
}

export const updatesDir = (): string => join(app.getPath('userData'), 'app-updates')
const stateFile = (): string => join(updatesDir(), 'state.json')

export function bootInfo(): BootInfo | undefined {
  return (globalThis as { __trenddeckBoot?: BootInfo }).__trenddeckBoot
}

export { newer } from './versions'

export function readState(): BootState | null {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<BootState>
    if (typeof s.version !== 'string' || typeof s.file !== 'string' || typeof s.shell !== 'string') return null
    return { version: s.version, file: s.file, shell: s.shell, tries: Number(s.tries) || 0 }
  } catch {
    return null
  }
}

export function writeState(s: BootState | null): void {
  try {
    if (!s) fs.rmSync(stateFile(), { force: true })
    else {
      fs.mkdirSync(updatesDir(), { recursive: true })
      fs.writeFileSync(`${stateFile()}.tmp`, JSON.stringify(s))
      fs.renameSync(`${stateFile()}.tmp`, stateFile())
    }
  } catch {
    // nothing to do, the bundled app still runs
  }
}
