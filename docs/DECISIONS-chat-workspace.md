# Decisions: the chat as the workspace

Calls made while moving review, suggestions, progress, storage and context into the chat.

## Cards from tools

- The agent puts cards in the chat with gateway tools, not with fenced blocks: `show_video`, `suggest`, `card_update`, `git_history` and `storage_copy`. Main keeps them per brand in `<user data>/cards/<brand>.json` (last 1500), and the chat shows each one under the reply that made it. A turn knows its reply's message id for that.
- All of these are read risk except `storage_copy`. They only show things; changing the project still goes through the editors' own tools.
- A FilmCraft tool whose name or command says render, export or preview puts the newest video it wrote (two folders deep) in the chat as a card, once per file per turn. This uses `onToolCalled` in the gateway.
- What you do on a card goes straight to the agent: a steer while a reply runs, otherwise a new message. The composer and its files are left alone.

## Native editor containment and sizing

Replaced by `DECISIONS-craft-web.md`: the cards host the apps' web builds as part of the page. What follows is
the native hosting it replaced.

- On Windows the Craft editor is now reparented with `SetParent` and `WS_CHILD`, rather than kept as a floating owned top-level window. It remains a separate native application, not an HTML/iframe editor. Unsupported native hosting must not be described as a web embed.
- The active editor defaults to **Whole chat**: the message column's width cap is removed, the stage uses the chat viewport's available height, and the composer remains below it. Inline/Large remain optional. Editor windows are resized, not stretched from a video-shaped screenshot.
- Inactive cards do not install dock observers. Native stray-window enumeration is throttled, live editing does not trigger still captures, and message entrance transforms are disabled around native editor surfaces.
- `npm run test:craft-native` verifies actual cross-process Windows child parenting, viewport bounds, clipping, zoom geometry and restoration using disposable off-screen fixture windows. This does not prove every third-party Craft build works.

## Craft-first collaboration

- Craft editors are the first-release integration target. Adobe Photoshop, Krita and other external editors remain post-release work; do not list them as supported embeddings.
- A visible card becomes eligible even when only a small part is in view. Explicit activation survives the card mounting, and ownership changes never automatically scroll the chat. Streaming replies do not pull an active whole-chat editor away from the creator.
- Native editor wheel input belongs to the editor, not the DOM. The external chat rail and Browse chat mode let the creator scroll the conversation without closing the project. Jump to latest sits outside the native stage instead of hiding it with an overlapping bubble.
- Circle and comment captures the current editor before hiding its native window, then offers circle/freehand markup and text on a screenshot. Sending stores a separate marked PNG for review_frame_get, includes the app/project/file and captured card/turn context, and leaves the project unchanged. Card revision is not a document revision; the agent must inspect the current document before applying feedback. Cancel sends nothing.
- Supported live bridges autosave every 30 seconds and before agent edits/controlled closes. Up to 30 distinct project-document snapshots live in .trenddeck/autosaves per project. Media is not duplicated. A failed save blocks destructive lifecycle operations; dialogs are never automatically dismissed. Unknown files and apps without save/bridge support cannot promise autosave, and snapshots currently require manual restoration with the editor closed.
- Dictate creates instructions in the composer; Take records footage, previews it, then saves for analysis without inserting it into an edit. A pending capture/unsaved preview cannot be hidden by toggling its toolbar button. OBS/take tools are registered through the agent gateway, and take_list discovers saved cards in the current brand/chat. Capture approval and remote-transcription disclosure remain explicit.

## Retaining your feedback

- Sent chats are stored locally. Removed chats are archived before removal; if the archive cannot be saved, deletion is refused.
- Unsent composer text is saved locally per brand/chat (and per project for new chats), restored after reopening, and removed when the composer clears. Storage failure displays a warning. Drafts are not sent to agents until submitted.
- Local chat history is private user data, not repository content. Review it for the user's feedback before making future TrendDeck changes; never publish the history.

## Video review controls

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
