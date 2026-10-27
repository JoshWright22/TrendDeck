// every speech-to-text adapter, in the order Settings lists them: hosted APIs first, then the
// generic endpoint, then servers on this computer
import { assemblyai } from './assemblyai'
import { aws } from './aws'
import { azure } from './azure'
import { deepgram } from './deepgram'
import { elevenlabs } from './elevenlabs'
import { gladia } from './gladia'
import { google } from './google'
import { mistral } from './mistral'
import { fireworks, groq, localai, localOpenAiCompatible, openai, openaiCompatible, openrouter, speaches, together } from './openai-compatible'
import { revai } from './revai'
import { speechmatics } from './speechmatics'
import type { SttProvider } from './types'
import { whisperCpp } from './whispercpp'

export type { SttProvider, SttModel, SttField, SttRequest, SttResult, SttWord, SttConfig, Fetch } from './types'
export { SttError } from './http'

export const STT_PROVIDERS: readonly SttProvider[] = [
  openai, groq, deepgram, assemblyai, elevenlabs, google, azure, speechmatics, revai, gladia, mistral, fireworks, together,
  openrouter, aws, openaiCompatible,
  whisperCpp, speaches, localai, localOpenAiCompatible
]
