# Decisions: visuals in the chat

Calls made while adding sketches, pasted images and visuals found online. Merge into DECISIONS.md once it lands.

## Sketch pad

- The pencil next to the paperclip opens it over the chat. It draws on a blank page (16:9, 9:16 or 1:1), a frame from the newest Craft editor in the chat (`trenddeckEmbed.still`, the same still the embed card shows), a pasted screenshot (Ctrl+V while it's open), a dropped image, or any image in the chat ("Draw on it" on visual cards and on attached Media images).
- Tools: pen, line, arrow, box, ellipse, text, eraser, undo and redo (Ctrl+Z, Ctrl+Y), clear. Drawing uses six marker colors; the pad's own buttons stay gray. The eraser removes whole shapes it touches.
- Shapes are kept as vectors in picture pixels (`chat/visuals/sketch.ts`, pure and unit tested with a recording canvas). The png is made only when you use an action, once per version of the drawing. Pictures over 2400 px on the long side are scaled down first.
- Drawing never changes an editor project. "Frame from FilmCraft" only takes a still.

## Where visuals live

- Sketches, pastes, dropped links and options you send to the agent are assets in `<user data>/visuals/<brand>/items/<id>.<ext>` with a json next to it. Search thumbnails are cached in `thumbs/`. Both are served to the window as `td-media://visual/<brand>/<items|thumbs>/<file>`; the window never loads a remote image, same as before.
- Nothing goes into a project folder until you pick "Add to video files" (or the agent calls `visual_save`). Then the file lands in `<project>/media/visuals/<name>.<ext>` with `<name>.<ext>.credit.json`: origin, provider, title, author, source page, file url, license (name, url, whether it needs credit, allows commercial use and changes) and the date it was retrieved. The same source added twice stays one file.
- A deleted brand takes its assets, thumbnails and picks with it. Files in project folders stay.

## Actions

- Every visual has the same buttons: Send to agent, Add to video files, Insert at playhead, Open in PhotoCraft, Draw on it (images).
- Send to agent attaches the image to your next message (`Attachment.visual`) and puts your note in the draft. A message can now go out with only attachments. Video and audio options go in as a line naming the option id, since an image attachment can't carry them.
- Insert at playhead and Open in PhotoCraft first add the file to the video files, then ask the agent to do it with the Craft tools, the same way attached Media files already did. TrendDeck doesn't open or drive the apps itself here, so this keeps working when the embeds change. It asks first when it's not clear: FilmCraft not open on the project ("Have your agent open it and insert there?"), or the project already has a PhotoCraft file ("Add as a layer in X" or "New PhotoCraft file").
- One light button per view: only the sketch pad's Send to agent is light; cards in the chat use quiet buttons.

## Paste and drag

- A pasted image or an image dragged out of a browser isn't a file on disk, so it becomes a visual instead of the old "save it first" error. In an open chat it shows as a card; in a new chat it's attached to the message.
- A link dropped from a browser is fetched by main: an image link is saved as it is, a page gives its `og:image` (or `twitter:image`) and title. Its license is unknown, and the card, the sidecar and the agent all say so.
- Files from Explorer still go through the Media library as before. Drops work anywhere on the chat column, not only on the composer.

## Finding visuals online

- Sources: Openverse and Wikimedia Commons without a key, Pexels and Pixabay with free keys from Settings, Media sources. Kinds: images (all four), videos (Wikimedia, Pexels, Pixabay), GIFs (Openverse, Wikimedia), audio (Openverse, Wikimedia). Pixabay's API has no audio or GIFs.
- License filter: any free license, OK for commercial use (the default in the composer), or no credit needed (public domain, CC0, Pexels and Pixabay licenses). Providers that can filter do it in the request; every result is checked again after parsing. Orientation works the same way.
- Results from several sources take turns in the grid. Each tile shows the thumbnail, title, source, license, author and size. Picking one shows the license with its link, whether credit is needed and commercial use is allowed, and the source page.
- Being polite: a minimum gap and an hourly cap per provider below their published limits, answers cached for a day (Pixabay asks for that), a provider that answers 429 left alone for the time it asks, one that fails or times out (12 s) skipped for two minutes. Wikimedia and Openverse get a User-Agent naming TrendDeck and its repo. Downloads only go to public http(s) hosts; every redirect hop is checked, sizes are capped (40 MB images, 400 MB video) and Pexels' key is only sent to its API, never to a redirect.
- The agent's `find_visuals` (read) puts the same grid in the chat as a card and gets a text list back with ids, licenses and source pages. `visual_get` (read) shows it an attached visual or an option's preview, scaled to 1600 px. `visual_save` (edit) adds a pick to the video files. `visual_credits` (read) lists the sidecars and gives a credits block for the description.

## Keys

- Pexels and Pixabay keys are sealed with safeStorage in `<user data>/visuals/keys.json`. They're used only in main's requests. The window learns only whether one is saved, no tool returns them, and their values are registered with the gateway's redaction. Without OS encryption they aren't saved at all.
- Pixabay's key has to ride in the query string. Request urls never reach a result, a card, an error or the audit log; errors are written from the status code only.

## The agent's next turn

- What you do with visuals that the agent wouldn't otherwise hear about (adding them to the video files) is noted per chat and told at the start of the next turn under "Visuals the user picked or made since your last reply", next to the editor changes summary. Sends and inserts are already messages, so they aren't repeated.

## Verified

- Unit tests: provider parsing against fixture shapes for all four providers (keys blank or a plain placeholder), license and orientation filters, image header sizes, assets, sidecars and credits, picks, the pacer, and sketch drawing, erasing, history and export names.
- `npm run check:visuals` against the live services: Wikimedia search, cached thumbnails, a 7.3 MB download into a temp project folder with its sidecar and credit line, Wikimedia video and audio search. Openverse's search API returned 504 or timed out during the whole session (its root endpoint answered), so Openverse was only checked against fixtures.
- An off-screen test instance with temp user data and projects folders and a scripted command agent: a sketch with a box, arrow, squiggle and text went out as an attachment with the note, the agent's prompt named the visual, and its `visual_get` call through the gateway returned the png. A pasted image became a card and was added to the video files; a composer search showed Wikimedia results with thumbnails, a pick was added with its sidecar, and the next turn told the agent about both. Screenshots in `docs/screenshots/visual-input/`.
- Not run: Pexels and Pixabay against the live APIs (no keys on this machine), dropping a link from a real browser, Insert at playhead and Open in PhotoCraft with the real apps (they only send the agent a message, which was not run against a real agent here), and a frame from a live Craft embed.
