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
| `--chalk` | `#E8E8E8` | main text |
| `--smoke` / `--faint` | `#9A9A9A` / `#666666` | secondary, hints |
| `--card` | `#E6E6E6` | primary buttons, text on it is `--felt` |
| `--accent` / `--accent-strong` | `#F5F5F5` / `#8D8D8D` | emphasis text and dots / focus rings |
| `--pink` | `#F87171` | errors only |

## Type

- Headlines: Inter Tight, ExtraBold or Black, tight (-0.04em), huge on landing pages.
- Body and UI: Inter, Regular and Medium.
- Numbers (scores, counts): Inter with tabular figures.
- Fonts are bundled, never loaded from a CDN in the app.

## Look

- **Plain surfaces.** Flat panels on black, separated by hairlines, not shadows or tinted cards. Rounded 8 px corners.
- **Status as small dots.** Gray for idle, white for running or done, red only for errors and recording.
- **Work collapses.** Agent tool calls fold into one "Worked · N steps" row that opens on click.
- **Light primary buttons.** One light button per view for the main action; everything else is a quiet hairline button.
- **No decoration.** No glows, gradients, textures, sparkles or mascots.

## Motion

Quiet. A short fade and slide with a plain ease-out: panels slide in about 12 px in about 200 ms. Hovers brighten, presses shrink a little. No overshoot, no bounce, no rotation, nothing that loops except a running dot's slow pulse. Respect reduced motion.

## Voice

Plain and direct. Short sentences. Talk to one creator, say "you". Say what happened and what's next ("Cut 14 filler words. Record the intro again?"), no puns or hype.
