# Decisions: Writer and Analytics

Calls made while building these two pages. Same idea as DECISIONS.md.

## Where things live

- Drafts and analytics readings each get their own json per brand, `writer/<brand>.json` and `analytics/<brand>.json` in the user data folder. They grow over time, so they stay out of `trenddeck.json` and the main store doesn't need to know about them.
- Deleting a brand deletes both files, same as its trends cache.
- All main process code for both pages sits in `src/main/analytics/`, drafts included, so the shared files only get a few added lines.
- Each page brings its own css file instead of adding to `styles.css`.
- The analytics api keys live in the brand's analytics file and are edited from the gear on the Analytics page, not the Settings modal. They're per brand anyway since each brand is a different account. The YouTube Data API key is the one already in Settings, the page only asks for the channel id or @handle.

## Writer

- A draft is one idea written five ways: YouTube, TikTok, Instagram, X and Reddit. Pick a saved idea or start blank. Starting from an idea fills the YouTube and Reddit titles with it.
- Drafts show as a row of small cards, newest edit first.
- Limits: YouTube title 100, description 5000, tags 500. TikTok and Instagram caption 2200 with the hashtags counted in, since they go out as one block. Instagram 30 hashtags. X 280 per post. Reddit title 300, body 40000.
- Counting: characters are counted the way you'd see them, so an emoji is one. X is weighted like X does it: links are 23, emoji and CJK are 2. YouTube tags count the commas between them, plus quotes around tags with spaces.
- Counters go yellow at 90% and pink past the limit. Each site tab has a dot with the worst state on it. Going over is allowed, it just shows.
- Copy buttons on every field, and Copy all per site. Caption and hashtags copy with a blank line between them, X posts copy joined by blank lines.
- Versions are per site. Save version keeps a copy, it skips it if the same text is already saved. Restore keeps what you had as a version first so nothing gets lost. 30 versions per site per draft, oldest drop off.
- Drafts save 400 ms after you stop typing and right away when you leave the page.

## Writer and the agent

- Generation goes through `generateDraft(prompt)` in `pages/writer/generate.ts`. The chat feature calls `provideDraftGenerator({ name, generateDraft })` once an agent is set up. Until then the button is replaced by a note and writing by hand is the whole feature.
- Agents only run when the user sends something, so the writer never calls the agent by itself. Pressing the button shows the full prompt in a box you can edit, and nothing goes out until you press Send. I'm counting that as the user sending a message.
- The prompt asks for json with the same field names as the editor. If the reply has no json the whole reply goes in the main field.
- Before a reply replaces your text, your text is saved as a version. The reply is saved as a version too, tagged "agent".

## Analytics

- Refresh is the only thing that reads anything. No timer, no reading on page open.
- Reading a site means opening it in a hidden, muted window on the brand's own session, the same logins as its tabs, reading the numbers, then closing it. One site at a time so a cheap laptop isn't loading three pages at once.
- YouTube: opens studio.youtube.com to find the channel and read "Current subscribers" from the dashboard, then reads the public videos page of that channel for recent videos and their views. Lifetime views aren't on either page, so without an api key the views chart is the sum of views on the recent videos it read.
- TikTok: reads the logged in username from tiktok.com, then the profile page for followers, likes, video count and the views on the grid.
- Instagram: finds the account from the login cookie, then makes the same profile calls the site makes, from inside the page. Followers, post count and recent posts with likes, comments and plays when Instagram sends them.
- With an api key set, that's used first and the page is the fallback. YouTube Data API needs the key from Settings plus a channel id or @handle. Instagram takes a token from the Instagram API with Instagram Login. TikTok takes a Display API token.
- Every refresh adds a reading per site. Up to 1500 are kept per brand, about a year of daily refreshes on all three.
- Charts are plain svg, no chart library. Thin dotted line, small dots, the latest reading is yellow with a pink glow. Hover shows the value and time. Ranges are 7, 30, 90 days or all.
- Stats show the change since the first reading in the range. Post views show the change since the last reading.
- If a site fails, its panel says why in pink and keeps the older readings.
- Sites can be switched off per brand in sources.
- The page readers can't be tested without real logged in accounts. They were only run logged out, where they report "not logged into ...". Sites change their pages often, so these are the parts most likely to need fixes.

## Other

- The count state for an empty field is called `blank`, not `empty`. `.empty` is already a global class in styles.css and it pulled every textarea out of place.
