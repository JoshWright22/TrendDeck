# Decisions: Craft apps

TrendDeck's editors are the Craft App Suite (github.com/storytold): FilmCraft, PhotoCraft, SoundCraft,
EffectCraft and the rest, native Rust apps that each ship a desktop app and a cli with its own MCP
server. TrendDeck installs them, opens them over its workspace pane and lets the agent drive them.
The renderer only shows state and asks through `window.trenddeckCraft` (`src/shared/craft.ts`), all
of it lives in `src/main/craft/`.

## Files

| File | What |
|---|---|
| `catalog.ts` | the 13 apps and how each one is started, driven and saved (flags differ per app) |
| `rules.ts` | pure rules: SHA256SUMS parsing, asset picking, zip entry paths, folder names, path containment, risk mapping, tool schemas. Tested in `__tests__/rules.test.ts` |
| `install.ts` | GitHub release lookup, download, hash check, unzip, staged updates, the 6 hour check |
| `paths.ts` | project folders and the app files in them |
| `launch.ts` | starting and closing app windows, control ports and tokens |
| `dock.ts` | keeping a window over the workspace pane, user32 through koffi |
| `mcp.ts` | a small stdio MCP client |
| `agent.ts` | the agent's connection to each app (bridge or headless), tool list cache, new files |
| `tools.ts` | gateway tools: `craft_list`, `craft_open`, `craft_files` and every app's own tools |
| `index.ts` | IPC, startup, quit |

## Why portable zips

- Every release has `<id>-<ver>-windows-{x64,arm64,x86}-portable.zip` and `SHA256SUMS.txt`. The zip
  needs no admin rights, no Windows Installer and no uninstall entry, and two versions can sit side by
  side, which is what makes swapping an update under a closed app safe. The MSI would put the app in
  Program Files for every user and fight with the ArtCraft Launcher over it.
- arm64 Windows takes the arm64 zip, else x64 (it runs under emulation). x86 takes x86.
- The download is streamed to a temp file and hashed on the way. Nothing is unpacked until the hash
  matches the release's `SHA256SUMS.txt`. The zip is unpacked with yauzl: the top folder is dropped,
  anything that would land outside the target (`..`, absolute paths, drive letters, device names) stops
  the install, symlinks are skipped, and the total unpacked size is capped.
- Unpacked into `<craft>\<id>\.download\<ver>` and renamed to `<craft>\<id>\<ver>` only when complete,
  so a half unpacked app is never picked. `<craft>\<id>\current.json` says which version runs.
- Portable mode keeps settings, presets and crash recovery next to the exe (`data\` or `<App>Data\`,
  whatever the app makes). An update copies everything in the old version's folder that the new zip
  doesn't ship into the new one, so settings follow the update. The zip's own files are never
  overwritten that way.
- One previous version is kept, older ones are deleted.

## Updates

- The latest release of each app comes from `api.github.com/repos/storytold/<id>/releases/latest`,
  asked with the last `ETag` so an unchanged answer doesn't count against GitHub's limit (60 an hour
  without a token). Cached in `<craft>\releases.json`.
- Checked 20 seconds after start and every 6 hours, and on `checkUpdates()`. `settings.autoUpdate ===
  false` still lets the check show the newest version but downloads nothing. `install()` on an
  installed app is the manual update.
- An open app is never replaced: the new version is unpacked next to it, `staged.json` and
  `status.updateReady` say so, and the swap happens when its window closes (or on next start).

## Where files go

- Apps: `%LOCALAPPDATA%\TrendDeck\craft\<id>\<version>\`. Machine local, not roaming, they're big.
  `TRENDDECK_CRAFT_DIR` overrides it for tests.
- Each TrendDeck project (one video) gets `Documents\TrendDeck\<brand>\<project>\`, made the first time
  something needs it and stored on the project as `folder` in `trenddeck.json`, so renaming the
  project or brand later doesn't move or lose it. Names are cleaned for Windows (no `<>:"/\|?*`, no
  trailing dots, no `CON` and friends, 80 characters) and made unique with ` (2)`, ` (3)`.
  `TRENDDECK_PROJECTS_DIR` overrides the root for tests.
- `files()` lists the app's types in that folder, newest first, names only. It doesn't make the folder.
- Opening an app with no file picks the newest file of its type. With none, a headless engine makes
  an empty one with the app's own tools (FilmCraft `command_run file.saveAs`, PhotoCraft `doc_new` then
  `doc_save`, and so on in `catalog.ts`), named after the project. If that fails the app opens empty
  and the user saves into the folder. LightCraft has no document, it opens on a library in
  `<project>\LightCraft Library` and `files()` lists the photos.

## Tokens

- Each window gets a fresh port and a fresh 32 byte hex token. The token goes in the app's environment
  (`FILMCRAFT_CONTROL_TOKEN`, `PHOTOCRAFT_CONTROL_TOKEN`, `GRIDCRAFT_CONTROL_TOKEN`) and the bridge
  cli's environment, never on a command line, in a file, to the renderer or to the agent. Other apps'
  `*_CONTROL_TOKEN` variables are stripped from every child's environment.
- The gateway's redaction scrubs live control tokens from anything an agent gets back (they're also
  64 hex, which the hex rule catches anyway).
- Limits: WordCraft and CADCraft make their own token file in the user's profile and their bridge reads
  it. VectorCraft, LightCraft, EffectCraft, DesignCraft, FigCraft, SoundCraft and DeckCraft have no
  token on their control port, so any process of this user on this machine can drive an open window of
  those. That's the apps' design, TrendDeck can't add one. PdfCraft's control channel isn't used.

## Docking

- The app stays its own process and its own top level window. Reparenting it as a child (`SetParent`)
  would tie the two message queues together, so a hung app would hang TrendDeck, and egui/winit apps
  don't expect to be children. Instead TrendDeck becomes its owner (`SetWindowLongPtrW(GWLP_HWNDPARENT)`):
  an owned window always sits above its owner, minimizes and hides with it, and is never above other
  apps the user switches to.
- Its caption, resize border and system menu styles are taken off and `WS_EX_APPWINDOW` too, so it has
  no title bar or taskbar button of its own. Some apps (PhotoCraft) draw their own title bar buttons
  inside the window; a maximize or minimize from there is undone on the next tick.
- The renderer sends the pane's rect in css pixels of the content area. Main multiplies by the zoom
  factor, adds the content origin (`getContentBounds`) and converts with `screen.dipToScreenRect`,
  then `SetWindowPos` with `SWP_ASYNCWINDOWPOS` so a busy app never blocks TrendDeck.
- It follows TrendDeck's move, resize, maximize, restore, minimize, hide, full screen and zoom events,
  and a 500 ms tick puts it back if the app moved itself and finds the window once it shows.
- The window is found by process id: visible, top level, titled, at least 200 by 150, not a tool or
  no-activate window (winit's hidden "Winit Thread Event Target" window and d3d and IME helpers would
  otherwise match).
- `visible: false`, a null rect, or TrendDeck minimized or hidden hides it.
- When TrendDeck's window closes the apps are let go first (owner cleared, styles back): Windows
  destroys owned windows with their owner, which would kill an app without its save prompt.
- If koffi or user32 fails, or the window never shows, the app is just a normal window next to TrendDeck.
- Limits: there's a frame of lag while dragging TrendDeck. Keyboard focus moves to the app when it's
  clicked, so TrendDeck's own window looks inactive while you work in it. Not done on macOS or Linux.

## Closing and quitting

- `close()` posts `WM_CLOSE` to the app's window, the same as its close button, so each app runs its
  own save prompt. No per app control protocol is needed for that. Waits up to 2 minutes.
- Quitting TrendDeck lets every window go, asks each to close and waits up to a minute. An app still
  open after that (its save prompt is up) is left running as a normal window. Headless engines save
  first.

## The agent

- Every installed app's own MCP tools are gateway tools named `<app>_<tool>`: `filmcraft_command_run`,
  `filmcraft_render_frame`, `photocraft_doc_export`. They go through the same validation, policy,
  approval, redaction and audit as every other tool. Plus `craft_list` (read), `craft_files` (read) and
  `craft_open` (edit, asks when it has to download the app first).
- Each takes `projectId`, the chat's project when left out. The agent never names a folder.
- Paths: any argument whose name says path, file, folder, location, output, input or destination, and
  any string anywhere that looks absolute, is resolved against the project folder and refused if it's
  outside it (`..`, other drives, UNC, `~`). The app gets absolute paths. Missing parent folders are
  made for edit tools, so `exports/thumb.png` works. The folder's own path in results is shown as `.`.
- Where an app supports it, its headless engine is also confined with `--automation-read-root` and
  `--automation-write-root` set to the project folder. FilmCraft, CADCraft, GridCraft and LightCraft
  have no such flags, TrendDeck's path check is the only fence there.
- Bridge or headless: if the app's window is open on the same project, calls go to
  `<id>-cli mcp <bridge flag> 127.0.0.1:<port>` with the window's token, so the user watches it work.
  Otherwise a headless engine (`<id>-cli mcp` with the project's newest file loaded by flag or by the
  app's open tool) runs it. One connection per app. A headless engine saves its file when the chat turn
  ends and is stopped after 10 idle minutes. A window opening on the app stops the headless engine
  first (it saves), so the window loads what the agent did.
- `ui_*` tools and the app's other window only tools need the window. PdfCraft has no bridge, so the
  agent can't use it while its window is open on that project.
- A crashed bridge restarts with backoff (1, 2, 4... 30 s) while the window is open.
- Tool lists are kept per app version in `<craft>\<id>\tools.json` so `tools/list` doesn't start
  anything. A fresh install asks a headless engine for its list. Window only tools appear once a
  window has been driven. The gateway asks for the list on every `tools/list`; its http server doesn't
  stream, so there's no `notifications/tools/list_changed`, the next list just has the new tools.
- Results pass through as MCP content: text (redacted) and images, so `render_frame` and
  `ui_screenshot` PNGs reach the agent. A call still running when the turn ends is cancelled with
  `notifications/cancelled`. Progress notifications keep long exports from timing out.

## Risk

| Tool | Risk |
|---|---|
| annotated `readOnlyHint: true` (inspects, lists, renders, previews) | read |
| everything else: commands, imports, exports, saves | edit |
| `ui_*`, even the read only ones | edit, they act on the window the user is looking at |
| a tool named delete, remove, trash, unlink, erase or purge | edit, always asks |
| `command_run` / `command_batch` running a command that removes files from disk (`file.delete`, `media.deleteFromDisk`, `proxies.delete`, the project manager...) | edit, asks that time |
| `craft_open` for an app that isn't installed | edit, asks (download) |

Nothing is publish or spend: the apps work on files in the project folder, posting stays with TrendDeck's
own posting tools.

## Verified

Against the real releases (FilmCraft 0.13.0, PhotoCraft 0.16.0) with a temp user data folder and
project root: install with hash check, new project files made headless, both opened docked and
following move, resize, maximize, minimize, restore and hide, `project_inspect`, `command_list`,
`media_import`, `command_run` and `render_frame` through the gateway in bridge and headless mode,
paths outside the folder refused, staged update swapped on close with settings carried over, quit
closing the windows and saving the headless engine. Screenshots in `docs/screenshots/craft/` (TrendDeck
captured over CDP, the app with `PrintWindow`, put together at the window's real offset).

The other 11 apps' flags come from their docs and cli source, not a run.
