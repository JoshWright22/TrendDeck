import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ToolError, type GatewayTool } from './gateway/types'
import { num, obj } from './gateway/validate'

// how fast you watch: TrendDeck's players play at this speed, FilmCraft in the chat switches to it
// after you press play (checkSpeed in craft/web.ts). only
// watching, never a clip's speed or a render. 2x by default, the agent can change it

export const DEFAULT_PREVIEW_SPEED = 2
export const PREVIEW_SPEEDS = { min: 0.25, max: 4 }

let speed = DEFAULT_PREVIEW_SPEED
let loaded = false
const file = (): string => join(app.getPath('userData'), 'preview-speed.json')

export const validSpeed = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= PREVIEW_SPEEDS.min && n <= PREVIEW_SPEEDS.max

export async function previewSpeed(): Promise<number> {
  if (!loaded) {
    loaded = true
    try {
      const v = (JSON.parse(await fs.readFile(file(), 'utf8')) as { speed?: unknown }).speed
      if (validSpeed(v)) speed = v
    } catch {
      // not set yet
    }
  }
  return speed
}

// the speed as last read, for the editor's watcher that can't wait
export const previewSpeedNow = (): number => speed

const listeners = new Set<(n: number) => void>()
export const onPreviewSpeed = (fn: (n: number) => void): void => void listeners.add(fn)

export async function setPreviewSpeed(n: number): Promise<number> {
  if (!validSpeed(n)) throw new Error(`a speed between ${PREVIEW_SPEEDS.min} and ${PREVIEW_SPEEDS.max}`)
  speed = Math.round(n * 100) / 100
  loaded = true
  await fs.writeFile(file(), JSON.stringify({ speed }), 'utf8')
  for (const fn of listeners) fn(speed)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('preview-speed:changed', speed)
  return speed
}

export function setupPreviewSpeed(): void {
  void previewSpeed()
  ipcMain.handle('preview-speed:get', () => previewSpeed())
  ipcMain.handle('preview-speed:set', (_e, n: unknown) => setPreviewSpeed(Number(n)))
}

export const PREVIEW_SPEED_TOOL: GatewayTool = {
  name: 'preview_speed',
  title: 'Set how fast videos play',
  risk: 'edit',
  description:
    "Sets the speed the user watches at: TrendDeck's video players play at it, and the FilmCraft editor in the chat switches to it shortly after the user presses play (2x by default, the user likes to watch fast). It only changes watching: never a clip's speed, the timeline or a render or export, which keep real time. Leave speed out to read it.",
  inputSchema: obj({ speed: num(`the playback speed, ${PREVIEW_SPEEDS.min} to ${PREVIEW_SPEEDS.max}, e.g. 2 for double speed`, PREVIEW_SPEEDS.min, PREVIEW_SPEEDS.max) }),
  run: async (_turn, args) => {
    if (args.speed === undefined) return { speed: await previewSpeed() }
    if (!validSpeed(args.speed)) throw new ToolError(`a speed between ${PREVIEW_SPEEDS.min} and ${PREVIEW_SPEEDS.max}`)
    return { speed: await setPreviewSpeed(args.speed), note: 'playback only, renders and clip speeds are unchanged' }
  }
}
