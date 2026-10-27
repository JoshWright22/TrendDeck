// a finished recording becomes a take card in the chat: transcript, cadence, script diff.
// OBS calls this when a recording it started for a project stops; the composer's recorder too

export interface RecordingInput {
  brandId: string
  projectId: string
  // absolute path of the file the recorder wrote
  path: string
  source: 'obs' | 'composer'
  // the chat to show the card in, null for the project's newest chat
  threadId: string | null
}

// filled in by takes/index.ts, so obs/ doesn't import the whole takes module
let handler: ((input: RecordingInput) => Promise<void>) | null = null

export function onRecording(fn: (input: RecordingInput) => Promise<void>): void {
  handler = fn
}

export async function ingestRecording(input: RecordingInput): Promise<void> {
  if (handler) await handler(input)
}
