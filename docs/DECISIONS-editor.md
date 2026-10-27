# Decisions: Editor core

Calls made while building the headless video and image editor. The design follows filmcraft (exact ticks, effects as data, one command registry); no code was copied. Merge into DECISIONS.md once it lands.

## Where things live

- `src/shared/editor/` is pure TypeScript: time, the project model, effect defs, every command, undo, file format, sync patches, frame resolution, inspect views and the agent tool descriptors. No node or DOM imports, so main and the renderer run the same code.
- `src/main/editor/` is the node half: the host that owns open projects, `.tdproj` files, autosave and the crash journal, and everything ffmpeg.
- Main owns every open project. The renderer, keyboard shortcuts and agents all go through the same `execute`, so there is one source of truth per project.

## Time

- Every position and length is an integer tick, 254,016,000,000 a second. Every common frame rate and sample rate divides it, so frame and sample edges are whole ticks and edits never drift.
- Ticks are plain numbers, not bigint. They survive JSON, IPC and `Math` untouched and are fast. The price is a ceiling at 2^53 ticks, about 9 h 51 min; conversions refuse anything past 9 hours.
- Commands take seconds, `"1.5s"`, `"90f"`, timecode (`;` for drop frame) or `{ticks}` and convert once at the edge. Timeline positions snap to the sequence's frames. Float seconds only appear again when talking to ffmpeg.
- Speed is a plain number; source ranges are rounded to the nearest tick.

## Model

- A project is a bin tree plus a flat map of items: media, sequences, subclips and graphics. Bins are a parent pointer per bin and a bin id per item, so there are no child lists to keep in sync.
- A graphic holds an image document (layers: raster, text, shape, adjustment). A title is a graphic with one text layer, so stills, titles and "Photoshop-lite" documents are one thing and share the `image.*` commands.
- Tracks hold sorted, non-overlapping clips. Every edit is checked against that after it runs, and an edit that would break it is refused instead of applied.
- Keyframes and transcripts are stored in the source's own time, so trims, splits, moves and speed changes never shift them.
- Captions live on caption tracks in sequence time. Ripple edits shift and cut them with the picture.
- Video and audio from one import share a link id and move, trim, split and delete together unless a command says `linked: false`.
- A split gives the left half the fade in and the right half the fade out, so a split doesn't add a fade at the cut.

## Commands and undo

- Every edit is a command spec with an id, label, menu path, shortcut, JSON schema params and a doc string. Menus, shortcuts and agent docs are generated from the registry.
- Args are checked against the schema before anything runs. Commands are pure, so "is this enabled" is a dry run and always agrees with what running it would do.
- Snapshots are immutable and share structure, so 200 undo levels cost only what each edit changed. Tests deep-freeze every snapshot to catch mutation.
- A batch is one undo step and all-or-nothing by default. Later steps can use earlier results with `"$0.sequenceId"`.
- An agent turn is a checkpoint plus a group: everything the agent does is one undo step, and the checkpoint can throw the whole turn away. Reverting is itself undoable.

## Agents

- Five tools: `command_list`, `command_run`, `command_batch`, `project_inspect`, `sequence_inspect`. The gateway registers `EditorHost.toolHandler()`.
- Agents never see file paths. They import with a media library id, and only files whose agent switch is on. `media.relink` and `media.set_proxy` are off limits to them.

## Files

- `.tdproj` is JSON with a format tag and a schema version. Old versions upgrade through a list of migrations; files from a newer app are refused with a clear message; files that break timeline rules are refused on load.
- Saves write a temp file in the same folder, flush it, then rename over the target, retrying briefly when Windows has the file locked.
- The crash journal is a full snapshot written about a second after edits stop, to `userData/editor/journal/`. It's dropped on save or a clean close and kept on quit when there are unsaved changes. Timed autosaves keep the last 10 copies.
- On open, media that moved is looked for next to the project file and in a `media` folder beside it.

## ffmpeg

- ffmpeg and ffprobe come from `ffmpeg-static` and `ffprobe-static` and are unpacked from the asar so they can run. Only the win32 x64 ffprobe is packaged.
- Exports and frame renders build one filter graph from the timeline. Each clip is its own input with an input-side seek, so a long timeline doesn't decode from the top for each clip. Clip chains run on the sequence clock and shift to the output clock just before they're composited.
- Text in titles is written to a file and read with `textfile`, so quotes, colons and percent signs need no escaping. Captions go through libass with the Windows fonts folder.
- Keyframed position, scale, rotation, opacity, contrast and saturation export exactly. Animated crop, blur, exposure and temperature export at their first value, with a warning. Non-normal blend modes, rotated text, ellipses, adjustment layers and nested sequences are listed as warnings too.
- Exports write to a `.partial` file and rename at the end. Cancelling kills ffmpeg and deletes the partial file.
- Proxies are 540p H.264 with a keyframe every 12 frames and no B-frames, so scrubbing seeks fast.
