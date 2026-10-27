# Decisions: the Craft apps in the workspace, and pre-publish checks

## FilmCraft replaces the built-in editor

- The editor core (`src/shared/editor/`, `src/main/editor/`, `window.trenddeckEditor`, `DECISIONS-editor.md`) is gone. Video, images, sound and motion are done in the storytold Craft apps, which TrendDeck installs and docks over the workspace pane. The agent drives them through each app's own MCP server, see `src/shared/craft.ts` for the contract and `src/main/craft/` for main's side.
- `ffmpeg-static` and `ffprobe-static` stay, with their `asarUnpack` lines, for the pre-publish checks.
- Default stages: Edit and Captions open `filmcraft`, Thumbnail opens `photocraft`. A stage saved with `editor` is read as `filmcraft` (`OLD_WORKSPACES` in `shared/pipeline.ts`, applied in `cleanStage`). Stage ids didn't change, so runs keep their state.
- `WORKSPACE_KEY` allows `craft:<id>` for apps without their own key. `WORKSPACES`, which the agent picks from, lists the four own keys and `craft:<id>` for the other nine.

## The workspace (`renderer/src/workspace/craft/`)

- `filmcraft`, `photocraft`, `soundcraft` and `effectcraft` are registered workspaces. Any `craft:<id>` key resolves to the same view for that app (`workspaceFor` falls back to it). Each app gets one component, so two stages on the same app don't remount it.
- Three states, from `list()` and kept live by `onChanged` in one window-wide store (`store.ts`):
  - not installed or failed: name, blurb, Install, a thin progress bar while it downloads, the error in red if it failed.
  - installed: the project's files for that app (`files()`), newest first, each with Open. When there are none, New opens the project's main file, which main makes empty. With files there's no New, because the contract has no way to ask for a second new file yet.
  - open (`running`): a 30px bar with the app name, the file, the agent dot (hollow off, gray headless, white bridge, red error) and Close, then a box the native window docks over. The box shows a faint line only visible while the window is hidden.
- Docking (`useDock.ts`): the box's `getBoundingClientRect()` in CSS pixels of the content area goes to `dock()`, measured once a frame on ResizeObserver, window resize, DOM mutations and transitions, and only sent when it changes. Minimizing isn't sent: `document.hidden` is also true when other windows just cover TrendDeck, and the app's window minimizes with its owner anyway. Main has to multiply by the window's zoom factor if it isn't 1.
- `visible: false` when: the pane is collapsed (`PaneContext` from `WorkspacePane`), the view goes away (stage or project change unmounts it, the cleanup sends it), or any TrendDeck overlay overlaps the box: modal backdrops, `aria-modal`, `role="dialog"`, `role="menu"`, `role="listbox"`, `.ui-pop`, the title bar search results and anything marked `data-over-craft`. That covers Settings, the pipeline editor, the Tools menu, the palette and the brand and site modals. The native window can't be drawn under page content, so hiding it is the only way an overlay can show.
- Tools menu: every Craft app after a hairline, with "Install" or "Open" as the hint. Picking one opens it as a tool for the current project.
- Settings, Craft apps: a table of all apps with installed and latest versions and status, Install, Uninstall (asks once), Update now (closes the app first if it's open, it saves on close) and Check for updates.
- `window.trenddeckCraft` is optional in the renderer. Without it, in a dev build or one made with `VITE_CRAFT_MOCK=1`, `mock.ts` stands in so the screens can be seen. A normal build without main's side shows a plain "can't run the Craft apps yet".

## Pre-publish checks (`src/main/qc/`)

- `qc:run (brandId, projectId, file, opts)` and the agent's `qc_run` (risk read) check an exported video in the project's folder. `qc_run` without a file lists the videos there. Progress goes out on `qc:progress`. The folder is `project.folder`, which main/craft saves on the project; `setQcFolder()` can swap the lookup. File names are kept inside the folder.
- Two ffmpeg passes: one over the whole file (ebur128 with true peak, silencedetect at -50 dB for 2s, and on a 360p copy of the picture blackdetect for 0.5s and freezedetect for 2s), and one over the first 3 seconds for a scene score per frame.
- Checks, each pass, warn or fail with one plain line and the times where it applies:
  - format: H.264, HEVC, VP9 or AV1, yuv420p, a sound track in a common codec.
  - size per target: YouTube 16:9 at 1920x1080 or more (720p warns), Shorts, Reels and TikTok exactly 1080x1920 (720x1280 and up warns), square 1:1. A wrong shape fails. The target is guessed from the shape unless given.
  - frame rate 23.5 to 61, length (Shorts warn past 60s, fail past 3 minutes).
  - loudness -16 to -12 LUFS integrated, true peak at or under -1 dBTP (over 0 fails).
  - silences, black and frozen stretches. Covering 90% of the video fails for silence and black.
  - first 3 seconds: a cut (scene score 0.3) or movement (average 0.015), otherwise warn.
  - captions: when a `.srt` or `.vtt` and a `.txt` named like the video (or `transcript.txt`) are there, word error rate. 5% or less passes, 15% warns.
