# Decisions: the Craft editors in the chat are their web builds

The chat used to put the native FilmCraft/PhotoCraft window over a chat card with Win32 (`craft/dock.ts`). A
window laid over the page can't scroll with the chat, can't be cut by it, can't sit under TrendDeck's menus
and only one can show at a time. Every Craft release also ships a web build (`<id>-web-<ver>.zip`): the same
engine and egui UI compiled to WebAssembly. The cards now host that build as a real part of the page, and the
native app does the heavy work in the background.

Screenshots: `docs/screenshots/craft-web-embed/`.

## Phase 1: what was measured

Electron 44 in a `<webview>`, Windows 11, 16 CPU threads, RTX 5070 Ti, FilmCraft 0.13.0, PhotoCraft 0.16.0.
Scratch harness first, then the built app (temp profile, off screen).

| | |
|---|---|
| Renderer | WebGPU, FilmCraft's GPU compositor, `crossOriginIsolated: true`, WebCodecs for H.264/HEVC/VP9/AV1, `threads: false` |
| Start | wasm compiled in 100 ms, app ready in 250 to 400 ms. In TrendDeck a card goes from Open here to its project open in 1.8 s (two 1 GB+ files registered) |
| Memory | one FilmCraft page about 260 MB after start, 550 MB with a 1080p clip, 950 MB to 1.4 GB playing a 1 GB file. Whole test app: 1.1 GB with one editor, 1.75 GB with FilmCraft and PhotoCraft live |
| Import | files go in as disk-backed `File` handles (devtools protocol `DOM.setFileInputFiles`), never copied: 46 ms for a 7 MB clip, 38 ms for a 1 GB one |
| Round trip | a native `.fcproj` opened in the web build with 0 missing media; new sequence, razor, caption track and caption, marker through `filmcraft.execute`; saved, read back with `readFile`, paths mapped back; `filmcraft-cli --project … inspect`, `media.findMissing` (0) and `captions.list` read it |
| Playback, 10 s 1080p H.264 | 0 dropped frames (half resolution), page at 130 fps |
| Playback, 1 GB 120 s 1080p 70 Mbps | 50 to 54% dropped, worst page frame gap 90 ms |
| Same with a proxy attached | 0 dropped, page at 139 fps |
| Proxy of that file | ffmpeg 480p/540p H.264, all cores: 3.2 s (8.1 s in the app with audio and progress). FilmCraft's own `media.createProxies h264_quarter` headless: 21.9 s. FilmCraft attaches both |
| Export, 300 frames 1080p H.264 | web build 49.7 s (6 fps, one thread). Native `filmcraft-cli export`: 5.3 to 5.7 s. Native with `hardwareEncoding: auto` (NVENC): 2.2 s, 2 s in the app |
| PhotoCraft | ready in 380 ms, 256 MB. No page API. A synthesized drop opens a `.pcraft`; File, Save downloads it as **`.psd`** (PhotoCraft's web save format), which the native CLI reads |

Decision: the web build is the editor in the chat by default, the desktop app is "Open in the full app".
Interaction stays in the page; exports, proxies, inspects and full-resolution frames go to the native engine.

## How it's put together

| File | What |
|---|---|
| `shared/craft-web.ts` | which apps run in the chat, the protocol's rules (MIME, ranges, url containment), project path mapping, FilmCraft's MCP tools as web calls, which cards run live, proxy rules. Unit tested |
| `main/craft/install.ts` | the web zip installs with the desktop app into `<craft>\<id>\<version>\web\`, checked against the same `SHA256SUMS.txt`, same updates and cleanup. An app installed before this gets its web build on first use (`ensureWeb`) |
| `main/craft/web-protocol.ts` | `craft-web://<app>/…`: the build, read only. `craft-web://<app>/_project/<token>/<file>`: the open project's folder, read only, byte ranges |
| `main/craft/web.ts` | the live editors: loading a project, saving it back, the agent's calls, downloads, stills |
| `main/craft/jobs.ts` | native exports and ffmpeg proxies in the background, each with a `craft-job` card |
| `preload/craft-web.ts` | files dropped on FilmCraft go through TrendDeck into the project folder |
| `renderer/…/CraftEmbed.tsx`, `embed-owner.ts`, `CraftJobCard.tsx` | the card |

### Serving

- `craft-web` is a privileged scheme (standard, secure, fetch, stream, code cache) registered with `td-media`
  (Electron allows one registration call). The editors' webviews live in `persist:craft-web` with their own
  preload, no node, sandboxed. `will-attach-webview` only allows that partition with a `craft-web://` source.
- Every response sends COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, `nosniff` and a CSP that
  allows only the page's own files, wasm and blobs. The session cancels any request that isn't `craft-web:`,
  `blob:` or `data:`, grants no permissions but clipboard write and fullscreen.
- Project files are read only, by a 128-bit token made per card and dropped when it closes, contained to the
  folder (dot segments, drive letters, backslashes, links out of it refused), with ranges (206, 416). FilmCraft
  itself reads footage through `File` handles (it streams 1 MiB pieces from disk); the scoped url is used to
  open the project document.

### A project in and out (FilmCraft)

- Open: the `.fcproj` is read on disk; its media and proxy paths that are in the project folder go in as `File`
  handles (`/files/<name>` in the page); the document is rewritten with those paths and opened by url. Media
  outside the folder shows offline and the card says how many.
- Only keys that hold paths (`path`, `*_path`, `*Path`) are mapped, so a clip named like its file keeps its name.
- Save: `file.save` in the page (its download is cancelled), `readFile`, paths mapped back, written to the
  project file atomically with recovery copies before and after (`.trenddeck/autosaves`, as before). Only
  when the project changed. It saves 4 s after you stop typing or clicking, every 30 s, before every agent
  edit, before an export, when the card lets go and when TrendDeck quits (a failed save stops the quit).
- Files added inside the editor's own Import dialog have no disk path; a save says so. Drops on the editor
  are caught by its preload and copied into `media/` like drops on the card.
- FilmCraft keeps its own copy of imported footage in the page's storage; TrendDeck clears that storage when
  the last editor of the app closes. FilmCraft's own crash recovery and demo are off (`?empty&norecover&fresh`).

### The agent

- `<app>_<tool>` tools still go through `sessionFor`. When an editor in the chat has the project open, the
  session is a `web` one whose client maps FilmCraft's MCP tools onto `window.filmcraft`
  (`filmcraftWebStep`): `command_run`/`command_batch` to `execute`, `ui_*` to `request`, `ui_screenshot` to
  `screenshot`, `media_import` to `File` handles (and a proxy job), `command_list` to `commands`.
- `project_inspect`, `doc_inspect`, `render_frame` and `render_preview` are answered by the native cli from a
  copy of what the editor has now, so ids, paths and frames are what the desktop app gives.
- `file.exportMedia`, `export.queue.*` run natively on the saved project with hardware encoding unless asked
  otherwise, with a progress card; the agent gets the engine's answer. `media.createProxies` makes ffmpeg
  proxies and attaches them in the editor.
- Saves and reloads (`file.save`, `saveCopy`, `revert`) go through TrendDeck's save and reload, so turn
  checkpoints, Undo this turn, Keep, markers from comments, alternatives and the edits summary work as before.
  Switching documents through the session is refused as before.
- With no editor in the chat on the project, the agent works headless as before. Apps without a page API
  (PhotoCraft): the agent works headless on the file on disk and the card reloads it afterwards; while the
  card may hold changes you haven't saved there, the agent is told to ask you to save first.

### The card

- Inline, Large and Whole chat as before. It scrolls and clips with the chat, menus and popovers draw over it.
- At most two editors run at once, one per document: the newest you can see, or the one you pick with Open
  here. One that runs keeps running while any of it is in view. The others show their last still.
- Letting go saves first and keeps the webview until that's done; a failed save keeps it open with the error.
- Stills: the page's own capture (12 ms). Circle and comment uses it; a frame at a time is rendered natively.
- An export started from the editor's own menu is cancelled in the page and run natively (`jobs.list` is
  watched every 2 s); the file goes to `exports/`.
- Open in the full app saves the editor in the chat, lets it go and starts the desktop app as a normal window
  of its own (no docking). Close the full app asks it to close with its own save prompt.

## Not done, and limits

- Apps other than FilmCraft and PhotoCraft open in the full app. EffectCraft, VectorCraft and FigCraft have
  page APIs (`window.effectcraft` and so on) and can follow the same pattern; SoundCraft, DesignCraft and the
  office apps have none.
- PhotoCraft's web build saves a `.psd`, so a save from its card is a `.psd` next to the `.pcraft`.
- A card unmounted at once (switching chats) can't wait for a save; the last input save or autosave is what's
  on disk.
- At Inline width FilmCraft's own menu bar overlaps itself; Large or Whole chat fits it.
- Open in the full app and the agent's gateway calls with a live agent were not run in the built app (the
  first puts a window on the screen of the person using this computer; the second needs a signed in agent).
  The same routing ran through the card's own calls (markers, sequence, stills, import, keep, undo) and unit
  tests.

## A threaded web build

- FilmCraft's docs: wasm threads need a cross-origin isolated page and a build with atomics (nightly
  `build-std` with `+atomics,+bulk-memory`), so it ships single-threaded and runs decode, render, mix and
  encode on the UI thread. No issue or roadmap item asks for a threaded build (searched for threads, atomics,
  SharedArrayBuffer). EffectCraft decided against it for now (its M13.24): it would parallelise loops inside a
  frame but not replace its Web Workers; LightCraft says COOP/COEP will be needed for a future atomics build.
- TrendDeck already serves the editors cross-origin isolated, so a threaded build would run here unchanged.
  What it would take upstream: nightly toolchain and `build-std`, `wasm-bindgen-rayon` (or a worker pool),
  shared memory sizing, and moving the cooperative frame server onto workers. With exports and proxies native,
  the gain in the chat would be playback of heavy footage without proxies.
