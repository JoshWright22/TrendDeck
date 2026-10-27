import type { GatewayTool } from '../gateway/types'
import { obsStatus, setupRecording, startRecording, stopRecording } from './service'

const projectSchema: GatewayTool['inputSchema'] = {
  type: 'object', properties: { projectId: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['projectId'], additionalProperties: false
}

export const OBS_TOOLS: GatewayTool[] = [
  {
    name: 'obs_status', title: 'Inspect local OBS', risk: 'read',
    description: 'Connect to existing local OBS WebSocket v5 and inspect recording/streaming, profiles, scenes and recording directory. No installs or configuration changes. Passwords stay in main.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (turn) => obsStatus(turn.brandId)
  },
  {
    name: 'obs_setup_recording', title: 'Set up OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'This changes the global OBS profile and recording directory; explicit approval is required',
    description: 'Propose/approve a brand/project recording setup in existing local OBS. Creates/selects a dedicated profile, writes only to the project Recordings folder and adds a media watch with agent access disabled. Never modifies configuration while recording/streaming. Scenes remain unchanged.',
    inputSchema: projectSchema,
    summarize: (turn, args) => `Create/select OBS profile TrendDeck-${turn.brandId}-${args.projectId} and set this project recording folder; add a media watch`,
    run: (turn, args) => setupRecording(turn.brandId, String(args.projectId))
  },
  {
    name: 'obs_start_recording', title: 'Start OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Starting recording always requires explicit approval',
    description: 'Start recording only in the approved brand/project OBS setup. Always asks; refuses external recordings, streaming or a changed profile/directory.',
    inputSchema: projectSchema,
    summarize: (_turn, args) => `Start local OBS recording for project ${args.projectId}`,
    run: (turn, args) => startRecording(turn.brandId, String(args.projectId))
  },
  {
    name: 'obs_stop_recording', title: 'Stop OBS recording', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Stopping recording always requires explicit approval',
    description: 'Stop only a recording started by this TrendDeck brand/project. Always asks. Never stops streaming or recordings owned by another brand.',
    inputSchema: projectSchema,
    summarize: (_turn, args) => `Stop local OBS recording for project ${args.projectId}`,
    run: (turn, args) => stopRecording(turn.brandId, String(args.projectId))
  }
]
