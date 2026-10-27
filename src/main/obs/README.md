# OBS

TrendDeck works with the OBS already installed and running on this computer, through its
WebSocket v5 server. Nothing is installed, launched or closed. The agent reaches OBS through
gateway tools, the window through `window.trenddeckObs` (`ObsApi` in `src/shared/obs.ts`).

## Files

- `protocol.ts` endpoint rules, v5 auth, frames, `ObsRequestError` (OBS answered "failed": the
  outcome is known) versus plain errors (timeout or dropped connection: the outcome is unknown).
- `client.ts` one connection: identify, correlated requests, 8 s timeouts, optional event
  subscriptions and one `onClose` for long-lived connections.
- `monitor.ts` the long-lived connection per brand (see Live connection).
- `rules.ts` pure rules for the per-brand recording settings.
- `preferences.ts` per-brand file in `userData/obs/<brand>.json`: endpoint, the password as
  safeStorage bytes, recording settings.
- `service.ts` every operation, ownership, restore and auto-import.
- `tools.ts` the gateway tools, registered in `src/main/gateway/index.ts`.
- `index.ts` IPC for the window.

## Settings, OBS (per brand)

- Address (loopback `ws://` only) and "Import password from local OBS", which reads OBS's own
  `plugin_config/obs-websocket/config.json` in main and keeps it with safeStorage.
- Profile: default keeps OBS's current profile. TrendDeck only switches to a profile that already
  exists and never creates one, because a blank profile loses the user's encoder and output setup.
- Scene collection: default keeps the current one. Only existing ones.
- Folder: a folder inside the project folder, default `footage` (`<project folder>\footage`).
  `{project}` and `{brand}` work. Absolute paths and `..` are refused.
- File name: default leaves OBS's own `Output.FilenameFormatting`. A pattern can use `{project}`,
  `{brand}` and OBS's `%` specifiers. No path separators.
- Auto-import: default on. A stopped TrendDeck recording becomes a take card.

The profile and scene collection stay switched after a recording (they're the user's own). The
record folder, and the file name format when a brand sets one, are remembered when a recording
starts and put back on the same profile after it stops, so OBS outside TrendDeck isn't left
pointing at a project. If OBS is busy at that moment, the restore waits for the next time OBS is
idle (seen through the monitor), once. If OBS switched profiles or someone changed the folder in
the meantime, their choice is left alone and the card says so. If the app quits mid-recording the
folder stays on the project; set it back in OBS, Settings, Output.

## Safety rules

- Only literal loopback `ws://` endpoints; `localhost` is pinned to 127.0.0.1.
- The password is never an IPC input, a tool argument or a result. Server error comments and close
  reasons are never echoed. Stream keys and stream service settings are never read or changed.
- All writes serialize through one global queue across brands.
- Every config write comes right after a fresh check that OBS isn't recording or streaming.
- A recording TrendDeck starts is owned by its brand and project. Another brand or project can't
  stop it or start another. A recording TrendDeck didn't start is never adopted or stopped, and
  while one runs TrendDeck changes nothing. If OBS's events were missed during our recording and
  the recording now in OBS is much shorter than ours, stop refuses (it isn't ours).
- No write is retried automatically. A start or stop whose outcome is unknown keeps an uncertain
  lock; the owning brand resolves it with an approved stop. A definite failure (OBS said no) puts
  the record folder back once.
- Ownership is not restored after an app restart; a running recording must then be stopped in OBS.
- External OBS UI or other clients can race the idle checks; OBS v5 has no global lease.

## Live connection

`ObsMonitor` keeps one connection per brand while a card or the pane shows OBS (watch/unwatch
from the window, by window, with a 10 s linger), while TrendDeck owns a recording, or while a
restore is pending. It subscribes to Outputs, Scenes and Config events, so a recording stopped
from OBS's own window is still seen: the owner is finalized, the folder is put back and the take
is imported. Reconnects back off 2, 5, 10, then 30 s. After a reconnect, a recording that stopped
meanwhile is finalized with the newest recording file in the folder. The preview's frames
(`GetSourceScreenshot`, jpg, 480 wide, at most one in flight) go through this connection only.

## Auto-import

When a TrendDeck recording stops (Stop on the card, `obs_stop_recording`, or OBS's own Stop) and
auto-import is on, `ingestRecording({ brandId, projectId, path, source: 'obs', threadId })` from
`src/main/takes/ingest.ts` is called with OBS's `outputPath`, after checking (realpath) that it's
inside the project folder. `threadId` is the chat the recording was started from. Main logs
`obs: importing take <relative path> for project <id>`.

## Agent tools

| Tool | Risk | Asks |
|---|---|---|
| `obs_status` | read | |
| `obs_scenes` scenes, program scene, inputs with mute | read | |
| `obs_screenshot` png, 960 wide by default, program or a named source | read | |
| `obs_show` puts the OBS card in the chat | read | |
| `obs_takes` recent recordings in the project's folder | read | |
| `obs_scene_switch` | edit | while streaming |
| `obs_input_mute` | edit | while streaming |
| `obs_setup_recording` profile and scene collection, makes the folder | edit | always |
| `obs_start_recording` | edit | always |
| `obs_stop_recording` | edit | always |
| `obs_stream_start`, `obs_stream_stop` | publish | always |

Record and Stop on the card or pane are the user's own action: no approval prompt, the same
ownership and idle checks.

## Verification

`TRENDDECK_SKIP_FFMPEG=1 npx vitest run src/main/obs` (fake transports and OBS state, nothing
real is started). Protocol sources: obs-websocket `docs/generated/protocol.md` and
`src/Config.cpp`.
