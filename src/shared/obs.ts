// OBS through its local WebSocket v5 server. main keeps the password, the window and the agent
// only ever see state, scenes, pictures and file names

// how a brand records, Settings, OBS. applied when a TrendDeck recording starts
export interface ObsRecordingSettings {
  // an existing OBS profile, '' keeps whatever profile OBS has on
  profile: string
  // an existing scene collection, '' keeps the current one
  sceneCollection: string
  // a folder inside the project folder, e.g. footage or footage\{brand}. '' means footage
  folder: string
  // OBS's file name format for the recording, with {project} and {brand} and OBS's own
  // % specifiers (%CCYY-%MM-%DD %hh-%mm-%ss). '' leaves OBS's own
  filename: string
  // a stopped recording becomes a take card in the chat
  autoImport: boolean
}

export const DEFAULT_RECORDING_SETTINGS: ObsRecordingSettings = {
  profile: '',
  sceneCollection: '',
  folder: 'footage',
  filename: '',
  autoImport: true
}

export interface ObsPreferences {
  endpoint: string
  hasPassword: boolean
  recording: ObsRecordingSettings
}

declare global {
  interface Window { trenddeckObs: ObsApi }
}

export interface ObsConnectionInput {
  endpoint: string
  importLocalPassword?: boolean
  clearPassword?: boolean
}

export interface ObsStatus {
  connected: boolean
  endpoint: string
  error?: string
  ownerBrandId?: string
  recording?: boolean
  streaming?: boolean
  // how long OBS has been recording, ms
  recordMs?: number
  currentProfile?: string
  profiles?: string[]
  currentSceneCollection?: string
  sceneCollections?: string[]
  currentScene?: string
  scenes?: string[]
  recordDirectory?: string
  // a problem putting OBS's own settings back after a recording, in words
  note?: string
}

export interface ObsInput {
  name: string
  kind: string
  // null for an input without audio
  muted: boolean | null
}

export interface ObsScenes {
  currentScene: string | null
  scenes: string[]
  inputs: ObsInput[]
}

// a recording in the project's OBS folder
export interface ObsTake {
  name: string
  // relative to the project folder, forward slashes
  file: string
  size: number
  modifiedAt: number
}

// what the card and the pane show, pushed on obs:live while something watches
export interface ObsLive {
  brandId: string
  connected: boolean
  // why it isn't connected, in words
  error: string
  recording: boolean
  streaming: boolean
  // ms OBS had been recording at `at`, the window counts on from there
  recordMs: number
  at: number
  // the recording is TrendDeck's, for this brand, and which project it's for
  ours: boolean
  projectId: string | null
  // TrendDeck is starting or stopping a recording and doesn't know the outcome yet
  uncertain: boolean
  currentScene: string | null
  scenes: string[]
  note: string
}

export interface ObsApi {
  preferences(brandId: string): Promise<ObsPreferences>
  configure(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences>
  saveSettings(brandId: string, patch: Partial<ObsRecordingSettings>): Promise<ObsPreferences>
  status(brandId: string): Promise<ObsStatus>
  scenes(brandId: string): Promise<ObsScenes>
  switchScene(brandId: string, scene: string): Promise<ObsScenes>
  // the program scene as a small jpg data URL, null when OBS isn't connected
  screenshot(brandId: string): Promise<string | null>
  // from the card or pane: the brand's recording settings are applied, then OBS records
  startRecording(brandId: string, projectId: string, threadId: string | null): Promise<ObsLive>
  stopRecording(brandId: string, projectId: string): Promise<ObsLive>
  takes(brandId: string, projectId: string): Promise<ObsTake[]>
  // puts an OBS card in that chat
  showCard(brandId: string, threadId: string, projectId: string | null): Promise<void>
  // keeps a live connection while a card or the pane is on screen, unwatch when it's hidden
  watch(brandId: string): Promise<ObsLive>
  unwatch(brandId: string): Promise<void>
  onLive(fn: (live: ObsLive) => void): () => void
}

export const OBS_CHANNELS = {
  preferences: 'obs:preferences',
  configure: 'obs:configure',
  saveSettings: 'obs:save-settings',
  status: 'obs:status',
  scenes: 'obs:scenes',
  switchScene: 'obs:switch-scene',
  screenshot: 'obs:screenshot',
  startRecording: 'obs:start-recording',
  stopRecording: 'obs:stop-recording',
  takes: 'obs:takes',
  showCard: 'obs:show-card',
  watch: 'obs:watch',
  unwatch: 'obs:unwatch',
  live: 'obs:live'
} as const
