// what a transcription gives back, local Whisper or an API: the text and every word with its time.
// shared by main (cadence, take diffs, scripts) and the ui

export interface SpokenWord {
  text: string
  // seconds from the start of the audio
  start: number
  end: number
}

export interface Transcription {
  text: string
  words: SpokenWord[]
  // seconds of audio that went in
  duration: number
  engine: 'local' | 'api'
  // the model that ran, e.g. whisper-base
  model: string
  // true when the word times are estimated (spread over a segment) rather than aligned per word
  wordTimesApproximate?: boolean
}
