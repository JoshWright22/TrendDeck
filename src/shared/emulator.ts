// types for the built in android phone, shared by main, preload and the ui

export interface SdkInfo {
  // folder the phone runs from, null when nothing usable was found
  root: string | null
  // true when it's the copy TrendDeck downloaded into its own data folder
  owned: boolean
  emulator: boolean
  adb: boolean
  avdmanager: boolean
  // system image folder relative to the sdk root, e.g. system-images/android-34/google_apis_playstore/x86_64
  image: string | null
}

export interface VirtCheck {
  // null when we can't tell yet, setup still works and the emulator checks again
  ok: boolean | null
  detail: string
}

export interface SetupProgress {
  running: boolean
  step: string
  // bytes for downloads, 0 when the step has no size
  done: number
  total: number
  error: string | null
  finished: boolean
}

export interface EmulatorStatus {
  sdk: SdkInfo
  // emulator, adb and a play store image are all there
  ready: boolean
  virt: VirtCheck
  setup: SetupProgress | null
  dataDir: string
  freeBytes: number | null
  // rough sizes for the setup screen before anything is fetched
  estimateDownload: number
  estimateDisk: number
}

export type PhoneState = 'off' | 'starting' | 'booting' | 'on' | 'stopping' | 'error'

export interface PhoneStatus {
  brandId: string
  state: PhoneState
  // brand has a phone on disk already
  created: boolean
  message: string | null
}

export interface PhoneFrame {
  width: number
  height: number
  // rgba, width * height * 4 bytes
  pixels: Uint8Array
}

export type PhoneKey = 'back' | 'home' | 'recents' | 'del' | 'enter' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'power'

export type PhoneInput =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: PhoneKey }

export interface EmulatorApi {
  status(): Promise<EmulatorStatus>
  // downloads everything into the app's data folder, progress comes through onSetup
  setup(): Promise<void>
  cancelSetup(): Promise<void>
  onSetup(fn: (p: SetupProgress) => void): () => void
  phone(brandId: string): Promise<PhoneStatus>
  onPhone(fn: (p: PhoneStatus) => void): () => void
  start(brandId: string, brandName: string): Promise<void>
  stop(brandId: string): Promise<void>
  // one screen grab, null when the phone isn't on
  frame(brandId: string): Promise<PhoneFrame | null>
  // h264 video of the screen, null chunk means the stream gave up and frame() should be used
  stream(brandId: string, on: boolean): Promise<void>
  onVideo(fn: (brandId: string, chunk: Uint8Array | null) => void): () => void
  input(brandId: string, input: PhoneInput): Promise<void>
  // asks for an apk file and installs it, resolves to a short message
  installApk(brandId: string): Promise<string>
  // opens the play store, or an app's page in it when a package name is given
  playStore(brandId: string, pkg?: string): Promise<void>
  // deletes the brand's phone and everything logged in on it
  wipe(brandId: string): Promise<void>
}
