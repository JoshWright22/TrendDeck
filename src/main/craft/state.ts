import { BrowserWindow } from 'electron'
import type { CraftAppStatus, CraftInstallState } from '@shared/craft'
import { APPS, spec } from './catalog'

// the live part of each app's status. install.ts, launch.ts and mcp.ts fill it in,
// status() puts it together and changed() sends it to the window on craft:changed
interface Live {
  install: CraftInstallState
  latest: string | null
  updateReady: string | null
  running: boolean
  brandId: string | null
  projectId: string | null
  file: string | null
  agent: CraftAppStatus['agent']
  autosave: CraftAppStatus['autosave']
}

const live = new Map<string, Live>()

function get(id: string): Live {
  let l = live.get(id)
  if (!l) {
    l = { install: { kind: 'not-installed' }, latest: null, updateReady: null, running: false, brandId: null, projectId: null, file: null, agent: 'off', autosave: undefined }
    live.set(id, l)
  }
  return l
}

export function setLive(id: string, patch: Partial<Live>, notify = true): void {
  Object.assign(get(id), patch)
  if (notify) changed(id)
}

export function liveOf(id: string): Readonly<Live> {
  return get(id)
}

export function status(id: string): CraftAppStatus {
  const s = spec(id)
  const l = get(id)
  return {
    app: { id: s.id, name: s.name, blurb: s.blurb, repo: s.repo, agent: s.agent },
    install: l.install,
    latest: l.latest,
    updateReady: l.updateReady,
    running: l.running,
    brandId: l.brandId,
    projectId: l.projectId,
    file: l.file,
    agent: l.agent,
    autosave: l.running && l.agent !== 'headless' ? l.autosave : undefined
  }
}

export function allStatus(): CraftAppStatus[] {
  return APPS.map((a) => status(a.id))
}

const listeners: ((id: string) => void)[] = []

// main's own listeners, the gateway's tool list follows installs and opens
export function onChanged(fn: (id: string) => void): void {
  listeners.push(fn)
}

// progress updates come fast, the window gets at most one every 200ms per app
const pending = new Map<string, NodeJS.Timeout>()
const lastSent = new Map<string, number>()

export function changed(id: string): void {
  for (const fn of listeners) {
    try {
      fn(id)
    } catch {
      // a listener failing doesn't stop the others
    }
  }
  const since = Date.now() - (lastSent.get(id) ?? 0)
  if (since >= 200) return send(id)
  if (!pending.has(id)) pending.set(id, setTimeout(() => send(id), 200 - since))
}

function send(id: string): void {
  clearTimeout(pending.get(id))
  pending.delete(id)
  lastSent.set(id, Date.now())
  const s = status(id)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('craft:changed', s)
  }
}

