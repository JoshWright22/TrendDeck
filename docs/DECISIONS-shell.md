# Decisions: the one-window shell (redesign, phase 1)

## Layout

- One window, three panes: the sidebar tree on the left, the chat in the middle, the workspace on the right. The old group nav (Discover, Plan, Create, Publish), the page tabs and the sidebar site list are gone.
- The look follows t3code: near-black background, gray text, hairline borders, one muted accent (`--accent`, a soft blue-violet), small status dots. The old token names (`--teal`, `--felt`, `--chalk`, ...) are kept and remapped in `styles.css`, so every page picks up the new look without being rewritten. `--teal` is now the accent.
- Headings are plain Inter. Inter Tight isn't loaded anymore. Only weights 400 to 600 are bundled and `font-synthesis-weight: none` stops the browser from faking 800 and 900, they render as 600.
- Layout rules for the shell are in `shell/shell.css`. Chat restyling is at the end of `chat/chat.css`, because that file loads lazily after `shell.css` and has to win.

## Sidebar

- Brands, then the open brand's Pipeline entry and its projects, then each project's chats. Only the open brand expands; clicking another brand switches to it. Ctrl+1..9 still switches brands. The brand cards in the title bar are gone because the sidebar does that job now.
- Project dots: hollow means idle, the accent dot breathes while any of its chats is replying, half filled means it needs you, gray means done. "Running" comes from the chats; the other three are set from the project menu.
- Chat search inside messages went away with the old chat list. Ctrl+K finds chats and projects by title.
- The Jobs strip at the bottom is a placeholder. It takes `JobInfo[]` (in `shared/workspace.ts`), but nothing feeds it yet.

## Projects and threads

- A project is one piece of content going through the pipeline. Each brand always has a General project with id `general`, and it comes first.
- Threads stay in `agents/history.ts`. A project only lists thread ids. Any thread that no project lists belongs to General. That's the migration: old chats show up under General without anyone touching the chat files.
- A chat started while a project is open gets filed under that project. Moving a chat is in its menu. Deleting a project moves its chats back to General, and nothing gets deleted.
- Which project and chat is open isn't saved, same as before. The app opens on General with a new chat.

## Workspace pane

- Stage strip on top, the stage's workspace below. Stages before the project's current one are filled, the current one has the accent, and the one being viewed is highlighted. "Move here" sets the project's stage.
- The Tools menu opens anything that isn't a pipeline stage: Trends, Inbox, Voice, Shorts, Phone, Sites and the rest. Ctrl+K opens them too.
- Sites live in the pane, with a row of tabs above the browser. Tabs can be dragged to reorder them. The kept-alive webviews always render in the same spot inside the pane. A collapsed pane is moved off screen at full width rather than resized to zero, so tabs don't lay out again or reload. Agents opening a site show the pane.
- Width and collapsed state are saved in localStorage on this machine. Ctrl+B toggles the pane, and you can drag its left edge to resize it.
- Settings is a big sheet over the app now, not a screen.

## Hooking in

- A stage's `workspace` is a key into `renderer/src/workspace/registry.tsx`. To add one, call `registerWorkspace('editor', { label: 'Editor', component })` with a component that takes `WorkspaceProps`. Use `tool: true` if it should also be in the Tools menu. Registering an existing key replaces it, so the real editor can take over `editor` from the placeholder. A key that isn't registered shows a placeholder, not an error.
- The component mounts under the stage strip in a `position: relative` box. Fill it with `position: absolute; inset: 0`, which the `.page` class already does.
- Main-side code reads and writes pipelines and projects through `src/main/workspace/index.ts`: `getPipeline`, `setPipeline`, `listProjects`, `saveProject`, `linkThread`. Each write saves `trenddeck.json` and sends `data:changed` to the renderer, which swaps in that copy. Otherwise the renderer's next save would put the old one back.
- The same calls are exposed over IPC as `window.trenddeckWorkspace`.
