// the Craft App Suite (github.com/storytold): native editors TrendDeck installs, opens next to its
// window and lets the agent drive through each app's own MCP server. main owns everything here,
// see src/main/craft/. the renderer only shows state and asks for things through window.trenddeckCraft

// one app of the suite. the id is the repo name and the prefix of its tools for the agent
export interface CraftApp {
  id: string
  name: string
  // what it's for, one line
  blurb: string
  repo: string
  // its release ships <id>-cli.exe with an MCP server, so the agent can use it
  agent: boolean
}

export type CraftInstallState =
  | { kind: 'not-installed' }
  | { kind: 'installing'; version: string; received: number; total: number }
  | { kind: 'installed'; version: string }
  | { kind: 'failed'; error: string }

export interface CraftAppStatus {
  app: CraftApp
  install: CraftInstallState
  // newest release on GitHub, null until checked
  latest: string | null
  // a newer version is downloaded and goes in when the app is next closed
  updateReady: string | null
  // its window is open
  running: boolean
  brandId: string | null
  projectId: string | null
  // the project file open in it, when TrendDeck opened it
  file: string | null
  // the agent's MCP connection to it
  agent: 'off' | 'headless' | 'bridge' | 'error'
  autosave?: {
    state: 'ready' | 'saving' | 'saved' | 'unavailable' | 'error'
    savedAt: number | null
    note: string
  }
}

// where the renderer wants an app's window: the workspace pane, in css pixels of the TrendDeck
// window's content area. main turns it into screen coordinates and keeps the app's window there
export interface CraftDock {
  appId: string
  bounds: { x: number; y: number; width: number; height: number } | null
  // false when the pane is hidden, another stage is showing, or a TrendDeck modal is open
  visible: boolean
  // the part of bounds that can be seen (same coordinates), when the box is partly scrolled out of
  // view. the app's window keeps its full size and is cut to this. null or left out: all of it
  clip?: { x: number; y: number; width: number; height: number } | null
}

export type CraftDockState = 'waiting' | 'docked' | 'hidden' | 'failed' | 'unsupported'

export function craftBelongsTo(
  status: Pick<CraftAppStatus, 'running' | 'brandId' | 'projectId'>,
  brandId: string,
  projectId: string
): boolean {
  return status.running && status.brandId === brandId && status.projectId === projectId
}

export interface CraftOpenRequest {
  appId: string
  brandId: string
  // the TrendDeck project (one video). its files live in its folder,
  // Documents\TrendDeck\<brand>\<project>\ (footage, .fcproj, .pcproj, exports), see main/craft/paths.ts
  projectId: string
  // a file in the project folder to open, or null for the project's main file of this app,
  // made empty on first open
  file?: string | null
  // the desktop app in its own window instead of the editor in the chat
  full?: boolean
}

// main -> renderer on 'craft:changed'
export type CraftChanged = CraftAppStatus

export interface CraftApi {
  // every app in the suite with its state
  list(): Promise<CraftAppStatus[]>
  // downloads the portable build from the app's GitHub release, checked against SHA256SUMS.txt
  install(appId: string): Promise<CraftAppStatus>
  uninstall(appId: string): Promise<void>
  // installs first if needed, then opens the window docked over the workspace
  open(req: CraftOpenRequest): Promise<CraftAppStatus>
  close(appId: string): Promise<void>
  // sent whenever the workspace pane moves, resizes, shows or hides
  dock(d: CraftDock): void
  dockState?(appId: string): Promise<CraftDockState>
  // the project folder's files for this app, newest first, names only
  files(brandId: string, projectId: string, appId: string): Promise<{ name: string; modified: number }[]>
  checkUpdates(): Promise<CraftAppStatus[]>
  onChanged(fn: (s: CraftChanged) => void): () => void
}

declare global {
  interface Window {
    trenddeckCraft: CraftApi
  }
}
