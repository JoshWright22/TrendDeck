import type { ObsCard } from '@shared/cards'
import { projectIdForThread } from '@shared/workspace'
import { addCard, newCardId } from '../cards/store'
import { ImageResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { bool, int, obj, str } from '../gateway/validate'
import { getData } from '../store'
import { obsPreferences } from './preferences'
import {
  configureObs, isStreaming, obsReadOnly, obsRequest, obsScenes, obsStatus, recentTakes, screenshot, setInputMute, setupRecording, startRecording, startStream,
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

const dataOf = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new ToolError('data must be a JSON object')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError('data must be a JSON object')
  return v as Record<string, unknown>
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
    description: "Puts the OBS card in the chat when the user is about to record or wants to see takes: a live preview, scene picker, Record and Stop, and recent takes. Only once OBS is connected, it refuses otherwise. Does not start recording or streaming; the user can record from the card themselves.",
    inputSchema: projectSchema,
    run: async (turn, args) => {
      const project = projectOf(turn, args.projectId)
      // a card that can only say "not connected" is noise in the chat, setup comes first
      try {
        await obsScenes(turn.brandId)
      } catch {
        throw new ToolError("OBS isn't connected, so there's nothing to show yet. Help the user set it up first (OBS running, its WebSocket server on, the password imported in Settings, OBS), then show it once obs_status says it's connected")
      }
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
    name: 'obs_get', title: 'Read from OBS', risk: 'read',
    description:
      "Any OBS WebSocket v5 read request (names starting with Get or List), answered as JSON: GetStats (fps, dropped/lagged frames, CPU, disk), GetVideoSettings (resolution, fps), GetRecordStatus, GetProfileParameter (Output/SimpleOutput/AdvOut/Video settings), GetSceneItemList (sources in a scene and whether they're shown), GetInputSettings, GetSourceFilterList, GetInputList, GetOutputList and the rest. Prefer this over screenshots for anything but how the picture looks. The stream key isn't readable.",
    inputSchema: obj({ request: str('the request name, e.g. GetStats', 80, 3), data: str('its requestData as a JSON object, {} or left out when it takes none', 4000) }, ['request']),
    run: (turn, args) => plain(async () => {
      const request = String(args.request)
      if (!obsReadOnly(request)) throw new ToolError(`${request} changes OBS, use obs_set`)
      return obsRequest(turn.brandId, request, dataOf(args.data))
    })
  },
  {
    name: 'obs_set', title: 'Change OBS', risk: 'edit',
    description:
      "Any OBS WebSocket v5 request that changes OBS: SetSceneItemEnabled (show or hide a source), SetVideoSettings (resolution, fps; only while not recording or streaming), SetProfileParameter (output settings), SetInputSettings, SetSourceFilterEnabled, CreateInput, SetCurrentProfile and the rest. Starting or stopping recording or streaming, and the stream key, are kept for their own tools. Asks first while OBS is live.",
    inputSchema: obj({ request: str('the request name, e.g. SetSceneItemEnabled', 80, 3), data: str('its requestData as a JSON object', 8000) }, ['request']),
    mustAsk: (turn) => liveWhy(turn, 'see the change'),
    summarize: (_turn, args) => `OBS: ${String(args.request)} ${typeof args.data === 'string' ? args.data.slice(0, 200) : ''}`.trim(),
    run: (turn, args) => plain(async () => {
      const request = String(args.request)
      if (obsReadOnly(request)) throw new ToolError(`${request} only reads, use obs_get`)
      return (await obsRequest(turn.brandId, request, dataOf(args.data))) ?? { ok: true }
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
    name: 'obs_import_password', title: 'Connect to OBS', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => "TrendDeck reads the WebSocket password from this computer's OBS settings and keeps it encrypted. Your agent never sees it",
    description:
      "Connects TrendDeck to the OBS on this computer, end to end: once the user approves, TrendDeck reads the WebSocket password from OBS's own settings, keeps it encrypted and checks the connection. You never see the password. OBS has to be running with Tools, WebSocket Server Settings: server on and authentication on. If it fails, tell the user what to turn on, or post open_settings with section OBS.",
    inputSchema: obj({ endpoint: str('the OBS WebSocket address, like ws://127.0.0.1:4455. leave it out for the one in Settings, OBS', 200, 1) }),
    summarize: (_turn, args) => `Import the OBS WebSocket password from this computer's OBS${typeof args.endpoint === 'string' ? ` for ${args.endpoint}` : ''} and connect`,
    run: (turn, args) => plain(async () => {
      const endpoint = typeof args.endpoint === 'string' ? args.endpoint : (await obsPreferences(turn.brandId)).endpoint
      const prefs = await configureObs(turn.brandId, { endpoint, importLocalPassword: true })
      const status = await obsStatus(turn.brandId).catch((err: unknown) => ({ connected: false, error: err instanceof Error ? err.message : String(err) }))
      return { passwordImported: prefs.hasPassword, endpoint: prefs.endpoint, status }
    })
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
