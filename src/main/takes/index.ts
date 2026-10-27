import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { takeFeedback } from '@shared/cadence'
import type { TakeCard } from '@shared/cards'
import type { Transcription } from '@shared/speech'
import { diffTake, paraphrases } from '@shared/take-diff'
import { ID_PATTERN } from '@shared/types'
import { addSpeech, logFriction, readCadenceProfile } from '../brand-memory'
import { checkProjectFile, FileRefError, relativeIn } from '../cards/files'
import { addCard, changeCard, getCard, listCards, newCardId } from '../cards/store'
import { projectOf } from '../cards/tools'
import { findProject, projectFolder } from '../craft/paths'
import { safeName, uniqueName } from '../craft/rules'
import { ffmpegPaths, run } from '../qc/ffmpeg'
import { ToolError, type GatewayTool } from '../gateway/types'
import { int, obj, str } from '../gateway/validate'
import { scriptLines } from '../scripts'
import { getData } from '../store'
import { onRecording, type RecordingInput } from './ingest'

// takes: a recording of the creator from the composer or OBS becomes a take card. main pulls
// the audio out with ffmpeg, the window's Whisper transcribes it (local by default), then main
// adds cadence feedback, compares it with the project's script and makes the pickup list

const MAX_TAKE_BYTES = 500_000_000
// about 30 minutes of 16 kHz float audio
const MAX_AUDIO_SECONDS = 1800

// the chat a take shows up in when the recorder didn't say: the project's newest chat
function threadFor(brandId: string, projectId: string): string | null {
  const p = getData()?.brands.find((b) => b.id === brandId)?.projects.find((x) => x.id === projectId)
  return p?.threadIds.at(-1) ?? null
}

async function createTake(input: RecordingInput): Promise<TakeCard> {
  const root = await projectFolder(input.brandId, input.projectId)
  let ref
  try {
    ref = (await checkProjectFile(input.brandId, input.projectId, relativeIn(root, input.path))).ref
  } catch (err) {
    throw new Error(err instanceof FileRefError ? err.message : 'That recording is not in the project folder.')
  }
  const now = Date.now()
  const card: TakeCard = {
    id: newCardId(),
    brandId: input.brandId,
    threadId: input.threadId ?? threadFor(input.brandId, input.projectId),
    messageId: null,
    at: now,
    updatedAt: now,
    type: 'take',
    projectId: input.projectId,
    media: ref,
    source: input.source,
    title: basename(input.path).replace(/\.[^.]+$/, ''),
    state: 'transcribing',
    error: '',
    transcript: null,
    feedback: null,
    diff: null
  }
  await addCard(card)
  return card
}

async function fullPath(card: TakeCard): Promise<string> {
  return (await checkProjectFile(card.brandId, card.projectId, card.media.file)).full
}

// 16 kHz mono float samples, what Whisper wants
async function takeAudio(brandId: string, cardId: string): Promise<ArrayBuffer> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'take') throw new Error('That take is gone.')
  const path = await fullPath(card)
  const { ffmpeg } = ffmpegPaths()
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', path, '-t', String(MAX_AUDIO_SECONDS), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
  if (!stdout.length) throw new Error('This recording has no sound.')
  return stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) as ArrayBuffer
}

async function analyze(card: TakeCard, transcript: Transcription): Promise<Pick<TakeCard, 'feedback' | 'diff'>> {
  const profile = await readCadenceProfile(card.brandId).catch(() => null)
  const feedback = takeFeedback(transcript.words, profile)
  const script = await scriptLines(card.brandId, card.projectId)
  const diff = script && script.lines.length && transcript.words.length ? diffTake(script.lines, transcript.words, script.file) : null
  return { feedback, diff }
}

async function setTranscript(brandId: string, cardId: string, transcript: Transcription | null, error: string): Promise<void> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'take') throw new Error('That take is gone.')
  if (!transcript) {
    await changeCard(brandId, cardId, (c) => {
      if (c.type !== 'take') return
      c.state = 'failed'
      c.error = error || "Couldn't transcribe this take."
    })
    return
  }
  const { feedback, diff } = await analyze(card, transcript)
  await changeCard(brandId, cardId, (c) => {
    if (c.type !== 'take') return
    c.state = 'ready'
    c.error = ''
    c.transcript = transcript
    c.feedback = feedback
    c.diff = diff
  })
  void addSpeech(brandId, transcript.words)
  // what the creator said instead of the script is the best evidence of their voice
  if (diff) for (const p of paraphrases(diff).slice(0, 10)) await logFriction(brandId, { kind: 'take-paraphrase', projectId: card.projectId, before: p.script, after: p.said, ref: p.lineId })
}

async function rediff(brandId: string, cardId: string): Promise<void> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'take' || !card.transcript) return
  const { feedback, diff } = await analyze(card, card.transcript)
  await changeCard(brandId, cardId, (c) => {
    if (c.type !== 'take') return
    c.feedback = feedback
    c.diff = diff
  })
}

// a take from the composer's recorder: into the project's footage\takes\ folder, then a card
async function saveRecording(brandId: string, threadId: string | null, projectId: string, name: string, mimeType: string, bytes: ArrayBuffer): Promise<void> {
  findProject(brandId, projectId)
  if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > MAX_TAKE_BYTES) throw new Error('A take has to be under 500 MB.')
  const ext = /^video\//.test(mimeType) ? (/mp4/.test(mimeType) ? 'mp4' : 'webm') : /mp4/.test(mimeType) ? 'm4a' : /ogg/.test(mimeType) ? 'ogg' : 'weba'
  const dir = join(await projectFolder(brandId, projectId), 'footage', 'takes')
  await fs.mkdir(dir, { recursive: true })
  const taken = (await fs.readdir(dir).catch(() => [] as string[])).map((n) => n.replace(/\.[^.]+$/, ''))
  const file = join(dir, `${uniqueName(safeName(name, 'Take'), taken)}.${ext}`)
  await fs.writeFile(file, Buffer.from(bytes))
  await createTake({ brandId, projectId, path: file, source: 'composer', threadId })
}

export const TAKE_TOOLS: GatewayTool[] = [
  {
    name: 'take_list',
    title: 'List saved takes in this chat',
    risk: 'read',
    description: 'Saved take cards in the current brand and chat, newest first, optionally filtered by project. Returns card ids, project-relative files and transcription state, not audio or transcripts. Use take_get to read a result. For OBS recordings on disk without a card, use obs_takes; an empty list does not mean no recordings exist.',
    inputSchema: obj({ projectId: str('only takes from this project in the current brand', 100, 1), limit: int('maximum number of takes, default 20', 1, 100) }),
    run: async (turn, args) => {
      if (!turn.threadId) throw new ToolError('take_list needs a chat. Open the project chat to list its take cards; use obs_takes for project recordings on disk.')
      const project = args.projectId === undefined ? null : projectOf(turn, args.projectId)
      return (await listCards(turn.brandId, turn.threadId))
        .filter((card): card is TakeCard => card.type === 'take' && (!project || card.projectId === project.id))
        .sort((first, second) => second.at - first.at)
        .slice(0, typeof args.limit === 'number' ? args.limit : 20)
        .map((card) => ({ cardId: card.id, projectId: card.projectId, title: card.title, file: card.media.file, source: card.source, state: card.state, at: card.at }))
    }
  },
  {
    name: 'take_get',
    title: 'Read a take',
    risk: 'read',
    description:
      "Read a take card from take_list in the current brand: transcription state, transcript with word times, cadence feedback, script comparison and pickup list. Does not start recording, retry transcription or upload audio. Pending and failed takes include their card id and file so the recording remains discoverable.",
    inputSchema: obj({ cardId: str('the take card id', 100, 1) }, ['cardId']),
    run: async (turn, args) => {
      const card = await getCard(turn.brandId, String(args.cardId))
      if (!card || card.type !== 'take') throw new ToolError(`no take ${String(args.cardId)}`)
      const details = { cardId: card.id, projectId: card.projectId, title: card.title, file: card.media.file, source: card.source, state: card.state }
      if (card.state !== 'ready' || !card.transcript) return { ...details, error: card.error, transcript: null, message: card.state === 'failed' ? 'This take could not be transcribed. Use show_video with the file to check playback.' : 'No transcript is available yet. Do not assume analysis is complete.' }
      return {
        ...details,
        transcript: card.transcript.words.map((w) => `${w.start.toFixed(2)} ${w.text.trim()}`).join('\n').slice(0, 40_000),
        feedback: card.feedback,
        script: card.diff ? { file: card.diff.scriptFile, lines: card.diff.lines.map((l) => ({ id: l.lineId, status: l.status, from: l.from, to: l.to, said: l.said })), pickups: card.diff.pickups } : 'the project has no script to compare with'
      }
    }
  },
  {
    name: 'take_show',
    title: 'Show a recording as a take',
    risk: 'edit',
    alwaysAsk: true,
    description: 'Creates a new take card from an existing project recording and starts transcription with the configured dictation source: this may send audio to a remote transcription service. Always asks permission. Does not record new footage. For playback without transcription use show_video; for existing analysis use take_list and take_get.',
    inputSchema: obj({ projectId: str("the project, by id. leave it out for this chat's project", 100), file: str('the recording, relative to the project folder', 260, 1) }, ['file']),
    summarize: (turn, args) => `Create a take from ${String(args.file)} in ${projectOf(turn, args.projectId).name} and transcribe it using the configured dictation source. This may send the recording's audio to a remote transcription service`,
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const root = await projectFolder(turn.brandId, p.id)
      let full: string
      try {
        full = (await checkProjectFile(turn.brandId, p.id, String(args.file))).full
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : 'not a recording in the project')
      }
      const card = await createTake({ brandId: turn.brandId, projectId: p.id, path: full, source: 'composer', threadId: turn.threadId })
      return `take card ${card.id} for ${relativeIn(root, full)}, it's being transcribed; read it with take_get when the creator asks`
    }
  }
]

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
function brandArg(e: IpcMainInvokeEvent, v: unknown): string {
  if (!fromApp(e) || typeof v !== 'string' || !ID_PATTERN.test(v)) throw new Error('bad takes call')
  return v
}
const str2 = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function cleanTranscript(raw: unknown): Transcription | null {
  if (!raw) return null
  const t = raw as Partial<Transcription>
  if (typeof t.text !== 'string') return null
  const words = (Array.isArray(t.words) ? t.words : [])
    .filter((w) => w && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
    .slice(0, 30000)
    .map((w) => ({ text: w.text.slice(0, 60), start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 }))
  return { text: t.text.slice(0, 200_000), words, duration: Number(t.duration) || 0, engine: t.engine === 'api' ? 'api' : 'local', model: str2(t.model, 80) }
}

export function setupTakes(): void {
  onRecording(async (input) => {
    await createTake(input)
  })
  ipcMain.handle('takes:from-file', async (e, b: unknown, thread: unknown, p: unknown, file: unknown) => {
    const brandId = brandArg(e, b)
    if (typeof p !== 'string' || !ID_PATTERN.test(p) || typeof file !== 'string') throw new Error('bad takes call')
    const { full } = await checkProjectFile(brandId, p, file)
    await createTake({ brandId, projectId: p, path: full, source: 'obs', threadId: typeof thread === 'string' ? thread : null })
  })
  ipcMain.handle('takes:save-recording', (e, b: unknown, thread: unknown, p: unknown, name: unknown, mime: unknown, bytes: unknown) => {
    const brandId = brandArg(e, b)
    if (typeof p !== 'string' || !ID_PATTERN.test(p)) throw new Error('bad takes call')
    return saveRecording(brandId, typeof thread === 'string' ? thread : null, p, str2(name, 120) || 'Take', str2(mime, 100), bytes as ArrayBuffer)
  })
  ipcMain.handle('takes:audio', (e, b: unknown, id: unknown) => takeAudio(brandArg(e, b), str2(id, 100)))
  ipcMain.handle('takes:set-transcript', (e, b: unknown, id: unknown, t: unknown, err: unknown) => setTranscript(brandArg(e, b), str2(id, 100), cleanTranscript(t), str2(err, 400)))
  ipcMain.handle('takes:rediff', (e, b: unknown, id: unknown) => rediff(brandArg(e, b), str2(id, 100)))
}
