import type { ObsCard } from '@shared/cards'
import { projectIdForThread } from '@shared/workspace'
import { addCard, newCardId } from '../cards/store'
import { ImageResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { bool, int, obj, str } from '../gateway/validate'
import { getData } from '../store'
import {
  isStreaming, obsScenes, obsStatus, recentTakes, screenshot, setInputMute, setupRecording, startRecording, startStream,
  stopRecording, stopStream, switchScene
} from './service'

// OBS for the agent. reads are read risk, scene and mute are edits, recording always asks, and
// streaming is publish risk that always asks. no tool takes or returns a password or stream key

const PROJECT = str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100, 1)
const projectSchema = obj({ projectId: PROJECT })

function projectOf(turn: Turn, projectId: unknown): { id: string; name: string } {
  const brand = getData()?.brands.find((b) => b.id === turn.brandId)
  if (!brand) throw new ToolError('this brand was deleted')
  const id = typeof projectId === 'string' && projectId ? projectId : projectIdForThread(brand.projects, turn.threadId ?? '')
  const p = brand.projects.find((x) => x.id === id)
  if (!p) throw new ToolError(`no project ${id} in this brand. projects: ${brand.projects.map((x) => `${x.id} (${x.name})`).join(', ')}`)
  return p
}

// a plain Error from the service is something the agent can act on, it goes back as is
const plain = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw new ToolError((err as Error).message)
  }
}

const liveWhy = async (turn: Turn, what: string): Promise<string | null> => {
  try {
    return (await isStreaming(turn.brandId)) ? `OBS is live, viewers will ${what}` : null
  } catch {
    return `TrendDeck couldn't check whether OBS is live, viewers may ${what}`
  }
}

const kb = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

export const OBS_TOOLS: GatewayTool[] = [
  {
    name: 'obs_status', title: 'Inspect local OBS', risk: 'read',
    description: 'Connect to existing local OBS WebSocket v5 and inspect recording/streaming, profiles, scene collections, scenes and recording directory. No installs or configuration changes. Passwords stay in main.',
    inputSchema: obj(),
    run: (turn) => obsStatus(turn.brandId)
  },
  {
    name: 'obs_scenes', title: 'List OBS scenes', risk: 'read',
    description: 'The scenes in OBS, the one on program (what records and streams), and the inputs with their mute state (muted is null for inputs without audio).',
    inputSchema: obj(),
    run: (turn) => plain(() => obsScenes(turn.brandId))
  },
  {
    name: 'obs_screenshot', title: 'Look at OBS', risk: 'read',
    description: 'A picture of what OBS shows on program right now, or of one scene or source by name. Use it to check framing, lighting and what is in the shot before recording.',
    inputSchema: obj({ source: str('a scene or source name from obs_scenes, leave it out for the program scene', 200, 1), width: int('picture width in pixels, 960 when left out', 160, 1920) }),
    run: (turn, args) => plain(async () => {
      const shot = await screenshot(turn.brandId, typeof args.source === 'string' ? args.source : undefined, typeof args.width === 'number' ? args.width : 960)
      return new ImageResult(shot.png, `OBS, ${shot.source}`)
    })
  },
  {
    name: 'obs_show', title: 'Show OBS in the chat', risk: 'read',
    description: 'Puts the OBS card in the chat before or after recording: connection, a live preview, scene picker, Record and Stop, and recent takes. Works even when disconnected so the user can see setup guidance. Does not start recording or streaming; the user can record from the card themselves.',
    inputSchema: projectSchema,
    run: async (turn, args) => {
      const project = projectOf(turn, args.projectId)
      const now = Date.now()
      const card: ObsCard = { id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now, type: 'obs', projectId: project.id }
      await addCard(card)
      return `OBS card is in the chat for ${project.name}`
    }
  },
  {
    name: 'obs_takes', title: 'List OBS takes', risk: 'read',
    description: "Recent recordings in the project's OBS folder, newest first, with size, time and project-relative file paths. Use show_video for playback or take_show to create a take card for analysis. These are files, not take card ids; use take_list for saved cards and take_get for their analysis.",
    inputSchema: projectSchema,
    run: (turn, args) => plain(async () => {
      const project = projectOf(turn, args.projectId)
      const takes = await recentTakes(turn.brandId, project.id)
      return takes.map((t) => ({ name: t.name, file: t.file, size: kb(t.size), at: new Date(t.modifiedAt).toISOString() }))
    })
  },
  {
    name: 'obs_scene_switch', title: 'Switch OBS scene', risk: 'edit',
    description: 'Switches the OBS program scene. Asks first while OBS is live.',
    inputSchema: obj({ scene: str('scene name from obs_scenes', 200, 1) }, ['scene']),
    mustAsk: (turn) => liveWhy(turn, 'see the switch'),
    summarize: (_turn, args) => `Switch OBS to the scene "${args.scene}"`,
    run: (turn, args) => plain(() => switchScene(turn.brandId, String(args.scene)))
  },
  {
    name: 'obs_input_mute', title: 'Mute or unmute an OBS input', risk: 'edit',
    description: 'Mutes or unmutes an OBS audio input by name, e.g. the mic. Asks first while OBS is live.',
    inputSchema: obj({ input: str('input name from obs_scenes', 200, 1), muted: bool('true to mute, false to unmute') }, ['input', 'muted']),
    mustAsk: (turn) => liveWhy(turn, 'hear the change'),
    summarize: (_turn, args) => `${args.muted ? 'Mute' : 'Unmute'} "${args.input}" in OBS`,
    run: (turn, args) => plain(() => setInputMute(turn.brandId, String(args.input), args.muted === true))
  },
  {
    name: 'obs_setup_recording', title: 'Set up OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'This switches OBS to the brand\'s profile and scene collection if Settings, OBS names them; explicit approval is required',
    description: "Gets OBS ready for this project: switches to the brand's OBS profile and scene collection (Settings, OBS; by default it keeps OBS's current ones) and makes the project's recording folder. Never changes anything while OBS records or streams. The record folder is only pointed at the project while a TrendDeck recording runs.",
    inputSchema: projectSchema,
    summarize: (turn, args) => `Get OBS ready to record ${projectOf(turn, args.projectId).name}`,
    run: (turn, args) => plain(() => setupRecording(turn.brandId, projectOf(turn, args.projectId).id))
  },
  {
    name: 'obs_start_recording', title: 'Start OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Starting recording always requires explicit approval',
    description: "Records the project in OBS with the brand's recording settings: OBS's record folder points at the project's folder (footage by default) until it stops, then goes back. Always asks; refuses while OBS records or streams on its own. When it stops, the take comes into the chat.",
    inputSchema: projectSchema,
    summarize: (turn, args) => `Start recording ${projectOf(turn, args.projectId).name} in OBS. If auto-import is enabled, the saved take is transcribed using the configured dictation source, which may send audio to a remote transcription service`,
    run: (turn, args) => plain(() => startRecording(turn.brandId, projectOf(turn, args.projectId).id, turn.threadId))
  },
  {
    name: 'obs_stop_recording', title: 'Stop OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Stopping recording always requires explicit approval',
    description: 'Stops only a recording TrendDeck started for this brand and project. Always asks. Never stops streaming or a recording started in OBS or by another brand.',
    inputSchema: projectSchema,
    summarize: (turn, args) => `Stop the OBS recording of ${projectOf(turn, args.projectId).name}`,
    run: (turn, args) => plain(() => stopRecording(turn.brandId, projectOf(turn, args.projectId).id))
  },
  {
    name: 'obs_stream_start', title: 'Go live in OBS', risk: 'publish', alwaysAsk: true,
    mustAsk: async () => 'This starts a live stream with the stream settings already in OBS; viewers will see it',
    description: "Starts streaming with whatever stream service and key OBS already has. TrendDeck never reads or changes them. Always asks.",
    inputSchema: obj(),
    summarize: () => 'Go live in OBS',
    run: (turn) => plain(() => startStream(turn.brandId))
  },
  {
    name: 'obs_stream_stop', title: 'End the OBS stream', risk: 'publish', alwaysAsk: true,
    mustAsk: async () => 'This ends the live stream for everyone watching',
    description: 'Stops streaming in OBS. Always asks.',
    inputSchema: obj(),
    summarize: () => 'End the live stream in OBS',
    run: (turn) => plain(() => stopStream(turn.brandId))
  }
]
