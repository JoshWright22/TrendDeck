# TrendDeck brand

The idea: your brands are a hand of cards, and TrendDeck deals you the trends worth playing.

## Logo

`resources/logo.svg`: a hand of three playing cards fanned from the bottom (indigo, pink, teal on top), white edges, large black YouTube and Instagram logos centered on the back cards and mostly hidden by the top card, a small rising-line mark in two corners of every card, and a black TD on the teal card where the D's curve rises into a yellow spark.

- Use it on off-black. On a light background, keep the white card edges and add the soft shadow.
- Minimum size 16 px (`resources/icon.ico` has the small sizes).
- Don't recolor the cards, rotate the hand, or take the TD off its card.
- Wordmark: "TrendDeck" in Inter Tight ExtraBold, letter spacing -0.05em, next to the mark with a gap of half the mark's width.

## Colors

| Name | Hex | Use |
|---|---|---|
| Felt | `#0E0E10` | background, the table everything is dealt onto |
| Panel | `#16161A` | panels, cards in the UI |
| Raised | `#1E1E24` | hover, raised panels |
| Line | `#2A2A33` | borders, dividers |
| Chalk | `#E8E8EC` | main text |
| Smoke | `#9A9AA6` | secondary text |
| Card white | `#F2F2F4` | card edges, pill buttons |
| Teal | `#00BF9C` | rising trends, primary actions, the top card |
| Yellow | `#FFD814` | highlights, the spark, wins |
| Pink | `#FA4E93` | hot items, alerts, the glow on the spark |
| Indigo | `#3B46A4` | soft glows and spotlights, secondary |

The surface is always Felt with an indigo spotlight glow. Accents stay small: one bright card or accent per view does more than a rainbow.

## Type

- Headlines: Inter Tight, ExtraBold or Black, tight (-0.04em), huge on landing pages.
- Body and UI: Inter, Regular and Medium.
- Numbers (scores, counts): Inter with tabular figures.
- Fonts are bundled, never loaded from a CDN in the app.

## Motifs

- **Cards.** Anything that is a thing you can pick (a brand, a trend, an idea, a draft) is a card: 5:7, rounded 12 px corners, white edge on art, the rising-line mark in the corners.
- **Marks.** Two marks, never a four-point sparkle. On cards: the rising line, a tiny trend line ending in a dot, in the corners where a suit would go. On backgrounds: the rounded diamond, for floating accents and texture. Teal for rising, pink for hot, yellow for a win.
- **Dealing.** Things arrive the way cards are dealt from the top of the deck: a short slide in, no spin.
- **Chips and stakes.** Growth scores and counts can sit in round chips. Use sparingly.
- **No dithering.** No dot-grid or dither textures. For texture use a faint tiled rounded-diamond pattern (about 5% opacity) that fades out.
- **Dotted lines.** Trend charts join points with thin dotted lines, the hottest point glows.
- **Pill buttons.** Small white or teal pills with dark text.

## Motion

Quiet by default, loud on a win. Everyday motion is a short fade and slide with a plain ease-out: cards rise 8 px in about 200 ms with a small stagger and panels slide in 12 px. Hovers lift a pixel or two and presses shrink a little. No overshoot, no rotation.

The bounce is saved for small wins, like saving an idea or a post going out: a quick pop that overshoots and settles, with a yellow spark burst. Nothing loops forever except a slow glow. Respect reduced motion, and keep slow devices fast (fewer particles, no blur on big areas).

## Voice

Plain and a little cocky, like someone who knows the odds. Short sentences. Talk to one creator, say "you". Card and table words are seasoning, not every line: "Deal yourself in", "Play your hand", "Every account in one deck".
