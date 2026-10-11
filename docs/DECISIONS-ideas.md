# Decisions: Ideas board and Schedule

Calls I made building the board and the schedule.

## Storage

- Everything lives in `trenddeck.json` with the rest of the brand. Board fields go on the existing `Idea` (stage, notes, tags, postedAt) and planned posts go in a new `schedule` list on the brand. No second file, so deleting a brand deletes its board and schedule too.
- The new fields are optional in the types so ideas saved from Trends still work. The store fills them in on load: an idea with no stage starts in the Idea column.
- The cleaning for those fields is in `src/main/planner/clean.ts`, `store.ts` only calls it.
- Order inside a column is just the order of the brand's ideas list. No separate order number to keep in sync.
- Named the list `schedule` and not `posts` so it doesn't clash with the posting work.

## Ideas board

- Five columns: Idea, Outline, Recorded, Edited, Posted. Fixed for now, no custom columns.
- Cards are 5:7 like the rest of the app, with the rising line mark in the top left and bottom right. Posted cards get a yellow mark and edge.
- Drag a card onto the top half of another card to drop it above, bottom half to drop it below. Dropping on empty column space puts it at the end.
- Keyboard: Enter opens a card, Delete removes it, Alt + left/right moves it a column.
- Quick add: New idea in the header or + on any column. New cards go on top of their column.
- Search matches title, notes, link and tags. `#word` only matches tags. Clicking a tag searches for it.
- Delete is instant with an Undo toast for 6 seconds. Ctrl+Z works too while the toast is up. Only the last delete can be undone.
- Motion is a short fade and 8px rise. The only bounce is the pop with a small yellow burst when a card lands in Posted, from a drag, Alt+arrow, the editor or a quick add there.
- Deleting an idea leaves its schedule slots alone. They show the slot title or "Untitled post" and say the idea was deleted.
- A small number on a card shows how many schedule slots link to it.
- Old `pages/Ideas.tsx` (the plain list) isn't used anymore. I left it in place, it can be deleted.

## Schedule

- Three views: Month, Week, List. The view you picked is kept while the app runs.
- Weeks start on Sunday.
- Month: double click a day or hit its + to plan a post. Drag a post to another day and it keeps its time. Clicking a date or "+N more" opens that week.
- Week: 24 hours, scrolled to 8am on open. Click empty space to plan a post on that half hour. Drag snaps to 15 minutes. Posts close in time sit side by side.
- List: coming up by default, Everything shows past posts too, newest first. The checkbox marks a post as posted.
- New posts default to 5pm and YouTube, or the platform you're filtering by.
- Platforms are a fixed list: YouTube, Shorts, TikTok, Instagram, X, Reddit, Other. The filter in the header shows one at a time.
- Each slot links one idea (or none) and has its own draft text. There's no Writer yet, so the draft is plain text on the slot. When Writer lands the slot can point at a Writer draft instead.
- Marking a slot posted doesn't move the idea to Posted. One idea can go out on several platforms, so that stays a choice you make on the board.
- Times are stored as local timestamps. If you change time zones the posts keep their real moment, so the clock time shown moves with you.

## Other

- `preload/index.ts` was missing `platform`, `windowControl` and `onMaximized` that the types and main process already had, so the typecheck failed before I started. I added those three so the build passes.
