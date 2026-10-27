// where a brand's big video files go besides this computer, and how the project history is kept.
// shared by main, preload and the ui

export type AfterCopy = 'keep' | 'archive'

export interface StorageSettings {
  brandId: string
  // remote:folder the agent copies to when it doesn't say, '' for none
  defaultDestination: string
  // keep: originals stay. archive: after the cloud copy checks out, the original goes to the recycle bin
  afterCopy: AfterCopy
}

export interface StorageRemoteView {
  name: string
  // drive, dropbox, onedrive, s3, r2, b2
  kind: string
  label: string
}

export interface StorageState {
  // rclone found on PATH
  rclone: boolean
  remotes: StorageRemoteView[]
  git: boolean
  settings: StorageSettings
  // a remote being set up right now, the browser may be open for its sign in
  connecting: string | null
}

export interface StorageRemoteInput {
  kind: string
  name: string
  accessKeyId?: string
  secretAccessKey?: string
  region?: string
  accountId?: string
}

export interface StorageApi {
  state(brandId: string): Promise<StorageState>
  setSettings(brandId: string, patch: Partial<Omit<StorageSettings, 'brandId'>>): Promise<StorageSettings>
  // runs rclone config create. drive, dropbox and onedrive open the browser to sign in
  addRemote(input: StorageRemoteInput): Promise<{ ok: boolean; note: string }>
  onChanged(fn: () => void): () => void
}

declare global {
  interface Window {
    trenddeckStorage: StorageApi
  }
}
