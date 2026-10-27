# OBS integration handoff

Only new files are supplied. No OBS process is installed, started, stopped, or
configured on import. No existing gateway, IPC, preload or renderer is changed.

## Parent wiring

- Import `OBS_TOOLS` and `setupObs` from `src/main/obs/index.ts`.
- Register `OBS_TOOLS` using the existing gateway `registerTools`.
- Call `setupObs()` once after Electron is ready and brand data is loaded.
- Expose the `ObsApi` shape from `src/shared/obs.ts` through the existing trusted
  preload: `preferences(brandId)`, `configure(brandId, input)`, `status(brandId)`
  invoke the matching `OBS_CHANNELS` values. Do not expose `service.ts`, raw
  request access, or credentials through preload/MCP.
- Configure input is `{ endpoint, importLocalPassword?: boolean,
  clearPassword?: boolean }`. There is deliberately no password field.
  The user explicitly imports the installed local OBS server password in main;
  only encrypted Electron safeStorage bytes are persisted per brand.
- Setup UI can instruct the user to open existing OBS, enable its WebSocket v5
  server, set authentication, and import local credentials. It never needs to
  display or receive the password. No renderer card is included.

## Safety and behavior

`obs_status` inspects version/capabilities, profiles, scenes, recording/streaming
and directory without mutation. `obs_setup_recording`, `obs_start_recording`,
and `obs_stop_recording` are gateway `edit` tools (the existing gateway has no
`write` risk), with both `alwaysAsk` and unconditional `mustAsk`.
Only the gateway registration should make these operations available to agents.

Approved setup creates/selects `TrendDeck-<brandId>-<projectId>` and sets
`Recordings` under the existing `projectFolder` helper. It adds an existing
media-library watch with agent access **disabled**. It does not alter scenes,
encoders, source capture, streaming credentials, or OBS installation. Profiles
are real OBS profiles; new profiles use OBS defaults, so users must configure
capture sources/output quality in OBS. No fake success/connection fallback.

All operations serialize globally across brands, not just per endpoint. An
in-memory owner binds brand, project, profile and directory. Other brands cannot
stop/start its recording. Setup checks both the target and previous owner's
server are idle before transferring ownership. Every OBS configuration write
is preceded by fresh recording/streaming checks. An active external recording
cannot be adopted or stopped. Ownership is intentionally not restored after
an app restart: an already-active recording must then be stopped manually in OBS.

Timeout/disconnect never retries writes automatically. An attempted start/stop
whose outcome is unknown retains an uncertain ownership lock. The owning brand
can inspect and explicitly approve stop to resolve it. Changes outside TrendDeck
to profile/directory block further recording controls and may require manual
recovery in OBS. External OBS UI/other clients can race the idle checks; OBS v5
has no global transaction/ownership lease. Partial setup is not rolled back
automatically; inspect OBS and approve setup again while idle.

Only literal loopback `ws://` endpoints are allowed; `localhost` is pinned to
127.0.0.1 to avoid hostname resolution changes. Connections are short-lived,
JSON RPC 1, with challenge authentication, correlated requests and 8-second
connection/request timeouts. Server error comments/close reasons are never
echoed. Passwords are neither IPC inputs nor tool arguments/results. Normal
installed OBS config paths are supported on Windows, macOS and Linux; portable
or nonstandard OBS config paths are not auto-discovered. Secure keychain storage
is mandatory for password import, including rejecting Linux basic_text fallback.

## Verification

Primary upstream sources checked during implementation:

- https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
  (Hello/Identify, authentication, request response, profiles, directory, outputs)
- https://github.com/obsproject/obs-websocket/blob/master/src/Config.cpp
  (local config keys used for explicit credential import)

Run `npx.cmd vitest run src/main/obs` and `npx.cmd tsc --noEmit -p tsconfig.node.json`.
Unit tests use pure protocol helpers and fake transports/OBS state; they do not
start recording. A live installed OBS end-to-end check requires parent wiring,
user-approved setup and a real running local OBS server.
