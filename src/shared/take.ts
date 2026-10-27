// what a take card shows besides the recording: cadence feedback and how the take compares to
// the script. the math lives in ./cadence and ./take-diff, these are the shapes

export interface TimedNote {
  // seconds into the take, the card makes it a link that seeks there
  at: number
  text: string
}

export interface TakeFeedback {
  duration: number
  words: number
  wpm: number
  // the creator's usual pace from the brand's cadence profile, null before there is one
  usualWpm: number | null
  fillers: { at: number; word: string }[]
  longPauses: { at: number; seconds: number }[]
  // plain advice with times, e.g. "You sped up to 210 words a minute here"
  notes: TimedNote[]
}

export type LineStatus = 'said' | 'paraphrased' | 'missed' | 'flubbed'

export interface LineMatch {
  lineId: string
  text: string
  status: LineStatus
  // share of the line's words found in order in the take, 0 to 1
  coverage: number
  // where in the take the line was said, null when it wasn't
  from: number | null
  to: number | null
  // what was actually said for it, '' when missed
  said: string
}

export interface Pickup {
  lineId: string
  text: string
  reason: string
  // where it went wrong in the take, null for a line that was skipped
  at: number | null
}

export interface TakeDiff {
  // the script it was compared with, relative to the project folder
  scriptFile: string
  lines: LineMatch[]
  pickups: Pickup[]
}

// window.trenddeckTakes
export interface TakesApi {
  // a recording already in the project folder (relative path) becomes a take card in the chat
  fromFile(brandId: string, threadId: string | null, projectId: string, file: string): Promise<void>
  // a recording from the composer: saved into the project's footage\takes\ folder, then a take card
  saveRecording(brandId: string, threadId: string | null, projectId: string, name: string, mimeType: string, bytes: ArrayBuffer): Promise<void>
  // 16 kHz mono float samples of a take's audio, for the window's Whisper
  audio(brandId: string, cardId: string): Promise<ArrayBuffer>
  setTranscript(brandId: string, cardId: string, transcript: import('./speech').Transcription | null, error?: string): Promise<void>
  // compare again, e.g. after the script changed
  rediff(brandId: string, cardId: string): Promise<void>
}

declare global {
  interface Window {
    trenddeckTakes: TakesApi
  }
}
