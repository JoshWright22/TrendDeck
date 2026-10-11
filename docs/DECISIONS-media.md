# Decisions: Media

Calls made while building the media library. Merge into DECISIONS.md once it lands.

## Storage

- Each brand's library is its own file, `media/<brandId>.json` in the user data folder, not inside `trenddeck.json`. The main store rebuilds its shape by hand on every save and would drop anything it doesn't know, and a few thousand files would make every brand save slow.
- Files stay where they are by default. "Copy into TrendDeck" copies them to `media/<brandId>/files/`, and a switch at the bottom of the filter list copies every new file in. Copied files keep working if the original moves.
- Thumbnails are small jpegs in `media/<brandId>/thumbs/`. Deleting a brand deletes its library, copies and thumbnails, never the user's own files.

## Library page

- Media sits between Ideas and Schedule in the sidebar.
- Drop files or folders anywhere on the page, or use Add files / Add folder. Windows can't pick files and folders in one dialog, so there are two buttons.
- A dropped or picked folder only brings in media (video, image, audio). A single file can be anything, it shows up under Other files.
- The same path is never added twice.
- Poster frames come from the app's own video element: it loads the file, seeks to a second in (or 10% for short clips) and draws the frame to a canvas. Images go through the same canvas. One file at a time so a big import doesn't open fifty decoders. Formats Chromium can't play (mkv with odd codecs, avi, heic) just get an icon and no length.
- Files are served to the app window through a `td-media://` scheme, by library id only, with range support so videos seek. It only exists in the app window's own session. Site tabs live in brand partitions and can't reach it, and the CSP doesn't allow fetch to it either, only img and video tags.
- Missing files get checked when the page loads, when the window gets focus, and at most every 5 seconds. They get a pink flag, a Missing filter, and a "Find it" button to point at the new spot.
- Remove takes a file out of the library, it never deletes your original. Undo shows for 8 seconds, but the removed file is kept for 2 minutes before copies and thumbnails are actually deleted. Removing a file that came from a watch folder remembers it so the next scan doesn't bring it back.
- Collections are named groups per brand, a file can be in several. Deleting a collection keeps the files. Tags are free text.
- Grid or list is remembered across brands.

## Watch folders

- Each brand can watch any number of folders, subfolders included. New media files show up a couple of seconds after they land. A file still being written (changed in the last 4 seconds) waits until it settles, so half-rendered exports don't get added.
- Folders get scanned on startup too, so files added while the app was closed show up.
- Files from a watch folder have the agent switch off unless the folder's own "Agents" box is on. Files you add by hand have it on. You didn't pick watch folder files one by one, so they don't go to an agent without you saying so.
- Removing a watch folder keeps the files it already brought in.

## Post status

- Every file has a list of where and when it was posted, with an optional link. Posting code calls `recordPost(id, platform, url)` from `src/main/media/upload.ts` once a post goes out. Until posting exists you can mark it by hand in the file details.
- Platform names are lowercase site names. The picker lists the brand's sites plus anything already used.
- "Not posted yet" shows files never posted anywhere, with a dropdown to narrow it to "not on YouTube" and so on.

## Agent access

- Agents get `listMedia(brandId, filter)`, `getMedia(id)` and `findMediaByName(brandId, name)` from `src/main/media` (main process, `agent.ts`). They return names, type, size, length, resolution, tags, collections and post status. Never a path, never the file. Files with the switch off and missing files don't show up at all, `getMedia` returns null for them.
- `resolveForUpload(id, { forAgent })` lives in `src/main/media/upload.ts` and is the only thing that turns an id into a path. It's not behind ipc, so the renderer and anything running in it can't call it. Posting and tab code import it in the main process. When an agent asked for the upload they pass `forAgent: true` and a file with the switch off gets refused.
- Agents can't browse the disk through any of this: every call takes a library id or a name inside one brand's library.
- The ui can see paths (the details panel shows where a file lives and opens it in Explorer). The renderer is the app's own code, agents never run there.

## Picker

- `<MediaPicker brandId onPick onClose multiple kind agentOnly />` from `src/renderer/src/pages/media/MediaPicker.tsx`. It hands back `MediaInfo` (no paths). The chat composer should pass `agentOnly` so it only offers files agents may use, the post composer leaves it off.
- The post composer, Shorts and the chat composer all use it. The chat passes `agentOnly`.
- `addPaths` hands back the library ids of the files too, new or already there, so the chat can attach a dropped file right after adding it.
