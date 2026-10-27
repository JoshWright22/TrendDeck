# TrendDeck brand

TrendDeck is where you and your agent make videos together, from the first idea to how the video does after it's posted.

## Logo

`resources/logo.svg`: the TD mark in light gray (`#E6E6E6`) on a black rounded square (`#0A0A0A`, corner radius about 22% of the side) with a faint gray edge. The D's curve ends in a small gray dot. No cards, no color.

- The same file is the app icon (`resources/icon.png`, `resources/icon.ico`) and the installer art (`resources/installer/`).
- Minimum size 16 px (`resources/icon.ico` has the small sizes).
- Don't recolor it or put the TD on anything but its square.
- Wordmark: "TrendDeck" in Inter Tight ExtraBold, letter spacing -0.05em, next to the mark with a gap of half the mark's width.

## Colors

The app, its icon, the installer and the landing page are black, white and grays only, like t3code's dark theme and learnharness: neutral grays with no tint, white-alpha hairlines, light primary buttons. Emphasis comes from brightness, not hue. The only color is red, for errors. Tokens live at the top of `src/renderer/src/styles.css`.

| Token | Value | Use |
|---|---|---|
| `--felt` | `#0A0A0A` | window background |
| `--panel` | `#121212` | sidebar, cards |
| `--raised` / `--hover` | `#1A1A1A` / `#1D1D1D` | menus, popovers, hover |
| `--line` / `--line-strong` | white 8% / 14% | borders, inputs |
| `--chalk` / `--text-2` | `#ECECEC` / `#D4D4D4` | main text, body text in lists (AAA: 16.8:1 and 13.4:1 on `--felt`) |
| `--smoke` | `#B0B0B0` | secondary text (AAA: 9.1:1 on `--felt`, 8.0:1 on `--raised`) |
| `--faint` | `#8A8A8A` | hints only (AA: 5.7:1 on `--felt`, 5.0:1 on `--raised`). Nothing that carries meaning goes darker |
| `--card` | `#E6E6E6` | primary buttons, text on it is `--felt` |
| `--accent` / `--accent-strong` | `#F5F5F5` / `#8D8D8D` | emphasis text and dots / focus rings |
| `--pink` | `#F87171` | errors and recording only |
| `--chat-max` | `46rem` | width of the centered chat column |

## Type

- UI and body: Segoe UI Variable (Text optical size for UI, Display for the few headings), the native Windows 11 face. TrendDeck is a Windows desktop app and most of its text is 12 to 14 px; Segoe UI Variable is hinted for ClearType at those sizes, so it reads crisper than Inter there and matches the window chrome and system dialogs around it. Inter stays bundled as the fallback where Segoe UI Variable isn't installed (older Windows, other systems).
- Headings use the same family at 600 weight and modest sizes (18 to 20 px). No display face.
- Numbers (scores, counts, times): tabular figures.
- Wordmark only: Inter Tight ExtraBold, see Logo.
- Fonts are bundled or system fonts, never loaded from a CDN in the app.

## Layout

- **Sidebar like t3code.** Brands are the groups. Each brand has one flat list of chats, newest first: no nested projects, no folders. A row is the chat title with its state on the right (a spinner and "Working", "Needs you", "New" for a reply that finished while you were away, otherwise the relative time like 5m or 3h) and, on a second line in plain text, the videos it's linked to ("Ep 12, Ep 13"). One "Videos" row per brand opens a plain table of its video projects.
- **One chat at a time, brand-wide.** The agent sees everything in the brand, every video project included. A chat can be linked to several videos; the agent makes and links them from the chat.
- **Centered chat column.** Messages, cards, the composer and the new chat screen sit in one column `--chat-max` wide, centered in the space between the sidebar and the window edge (or the right pane). Text inside it is left-aligned: headings, paragraphs and starter rows never center.
- **Quiet chat header.** The chat title, then the linked videos in secondary text. Each linked video gets one progress row (name, where it is, what's next) with its actions in a menu, not a row of buttons.

## Look

- **Plain surfaces.** Flat panels on black, separated by hairlines, not shadows or tinted cards. Rounded 8 px corners.
- **Status in words.** Label running, recording, waiting and error states in words ("Working", "Needs you"). No colored dots in front of text.
- **One set of controls.** Pickers are the app's own Dropdown and Menu (`src/renderer/src/chat/ui`), never a raw native `<select>`, so every list looks and works the same with the keyboard.
- **Work collapses.** Agent tool calls fold into one "Worked, N steps" row that opens on click.
- **Light primary buttons.** One light button per view for the main action; everything else is a quiet hairline button.
- **No decoration.** No glows, gradients, textures, sparkles or mascots.

## Motion

Quiet. A short fade and slide with a plain ease-out: panels slide in about 12 px in about 200 ms. Hovers brighten, presses shrink a little. No overshoot, no bounce, no blur. The only things that loop are the small spinner next to "Working" and a running step's slow pulse. Respect reduced motion: the spinner stops.

## Voice

Plain and direct. Short sentences. Talk to one creator, say "you". Say what happened and what's next ("Cut 14 filler words. Record the intro again?"), no puns or hype.

## Avoid

These read as generated, template work. Don't use them in the app, the installer or the website.

- Copy: "I built" framing; filler summary sentences that are just a comma list of features; hype and vague promises.
- Small ALL-CAPS eyebrow labels over big dramatic titles. Labels are sentence case at body size.
- Blur animations, blur reveals, scroll choreography, anything that delays reading.
- Buttons with a colored left border or margin stripe; pill buttons with colored or gradient borders; colored drop shadows.
- "·" middot separators between words. Use commas, words ("checked 5m ago") or layout.
- Colored dots in front of text as decoration or as the only sign of a state.
- Serif display fonts (Instrument Serif, Fraunces, Young Serif, Bodoni) and the trendy picks (Space Grotesk, Sora, Syne, Bricolage Grotesque, Geist).
- Emoji as icons. Icons are simple line SVGs in `currentColor`.
- Purple or any other accent hue. Black, white and grays only; red only for errors and recording.
- Glows, gradients, glassmorphism and frosted panels.
- Center-aligned app content: centered headings, paragraphs and button grids. The chat column itself is centered; what's inside it is left-aligned.
- A generic flat sidebar with emoji icons, and the stock shadcn look (default cards with icons on top, default radii and shadows everywhere).
- Barely passing contrast. Body text is AAA (7:1 or more), secondary text AA (4.5:1) or better, see Colors.
- Inconsistent controls: raw native selects next to themed dropdowns, three ways to show the same state.

## Product and website checklist

- Lead with what creators can do, not "I built" or vague promises about the future of work. Use real screenshots and specific workflows.
- Do not repeat an uppercase eyebrow, enormous headline and empty one-line summary in every section. Use descriptive headings and enough detail to make a decision.
- Navigation communicates location and available actions. Avoid decorative colored rails, meaningless separators and ornamental badges.
- Use plain buttons with explicit verbs. No gradient pills or colored-border pills for decoration.
- Keep controls readable and keyboard accessible. Do not use fashionable serif display fonts, tiny labels or low-contrast text at the expense of comprehension.
- Avoid blur reveals, scroll choreography and effects that delay reading or interaction. Respect reduced motion and prioritize responsiveness.
- Chat is the production workspace. Show previews, review requests, progress and private input where the conversation happens. The agent manages the pipeline; an optional tool pane is not the primary workflow.
- Distinguish working features from planned capabilities. A dock placeholder is not an editor, a pending suggestion is not an applied edit, and a cloud destination is not a completed upload.
