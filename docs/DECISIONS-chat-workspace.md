# Decisions: the chat as the workspace

Calls made while moving review, suggestions, progress, storage and context into the chat.

## Cards from tools

- The agent puts cards in the chat with gateway tools, not with fenced blocks: `show_video`, `suggest`, `card_update`, `git_history` and `storage_copy`. Main keeps them per brand in `<user data>/cards/<brand>.json` (last 1500), and the chat shows each one under the reply that made it. A turn knows its reply's message id for that.
- All of these are read risk except `storage_copy`. They only show things; changing the project still goes through the editors' own tools.
- A FilmCraft tool whose name or command says render, export or preview puts the newest video it wrote (two folders deep) in the chat as a card, once per file per turn. This uses `onToolCalled` in the gateway.
- What you do on a card goes straight to the agent: a steer while a reply runs, otherwise a new message. The composer and its files are left alone.

## Video review

- Project files play through the existing `td-media:` protocol as `td-media://project/<brand>/<project>/<file>`, so the CSP doesn't change. Only video, image and audio files inside a known project folder are served, with no links.
- Comments go out as a readable list plus a `trenddeck-review` json block (`formatReview` and `parseReview` in `@shared/cards`). Frames you drew a box on are saved as PNGs with the box outlined, in `<user data>/cards/frames/<brand>/`, and the agent sees them with `review_frame_get`.
- "Open in FilmCraft here" opens FilmCraft on the project in the chat and asks the agent to move the playhead. TrendDeck has no direct playhead control of its own.

## Edit suggestions

- Apply first copies the project's editor files (the Craft apps' files at the top of the folder) to `.trenddeck/checkpoints/<card>/`, then asks the agent to apply the edit. The card only says applied when the agent reports it with `card_update`.
- Restore checkpoint copies those files back, and only while no editor has the project open. The files it replaces go aside as `.before-restore`.
- Preview and Undo ask the agent to do it, because only the editor knows how to render a proposal or undo in its own history.

## Uploads

- Ask about it sends the file's media id to the agent and nothing else.
- Add to project media copies the file into `<project>/media/`. The same file added twice stays one file.
- Insert at playhead and Replace selection add the file to the project, check that FilmCraft is open on it (and ask before opening it), then ask the agent to place it with the filmcraft tools. The agent asks you when the target isn't clear.

## The pane and the pipeline

- The right pane only docks the Craft apps, OBS (key `obs`), the phone and site tabs. The old pages are gone from it.
- Default stages open nothing or a Craft app or OBS. Saved pipelines lose the `research` stage that opened `trends` when they load (`migrateStages`); a pipeline with nothing left gets the defaults.

## Storage and history

- Cloud copies use rclone remotes: Google Drive (scope drive.file), Dropbox, OneDrive, Amazon S3, Cloudflare R2 (s3 with Cloudflare's endpoint) and Backblaze B2. Settings, Storage runs `rclone config create`. Keys go straight to rclone's config; TrendDeck only remembers which remote is R2.
- After each copy, `rclone check --one-way` compares it with the cloud (hashes when both sides have one, sizes otherwise). With "move the original to the Recycle Bin" on, only a checked original goes, and to the Recycle Bin, not deleted.
- History is the existing metadata-only git repository: text files (.md, .txt, .json, .srt, .vtt and so on), never media or the editors' binary files. Save a checkpoint commits every changed text file (up to 50). Restore writes the files back as they were at that checkpoint without committing, and files added since stay.

## Your own MCP servers and context

- See `src/main/mcp-servers/` and `src/main/context/`. A server's tools are listed only for brands it's on for (tool sources get the turn now). Untrusted servers ask before every call, and secret env and header values are kept with safeStorage and never go back to the window or an agent.
- Style rules reach the agent on every turn (capped at 2500 characters) only after you approve `remember_style` or add them yourself.
