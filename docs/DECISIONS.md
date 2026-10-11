# Decisions

Calls made while building, so nobody has to guess later.

## Layout

- Brand switcher is a compact rail of brand cards at the top of the sidebar, not a dropdown. Every brand stays one click away and the shortcut number shows on hover.
- The app always opens on Trends. What each brand has open isn't saved, only kept while the app runs.
- Only the open site has a webview. Leaving a site unmounts it, and coming back reopens the last page you were on (in memory only). Logins live in the brand's session so nothing is lost, the page just reloads.
- Ctrl+1..9 (Cmd on macOS) picks the brand in rail order. When a site has focus the main process catches the keys first, otherwise the site would eat them.
- Chat sits on the right, toggled from the top right of every page. Threads are saved per brand. No agent is wired up yet, so sending just saves your message to the thread.
- Pages and the chat pane are lazy loaded, each one is its own chunk.
- Fonts (Inter, Inter Tight) come from @fontsource and get bundled, latin subset only to keep the build small.

## Trends

- Everything is fetched in the main process through the brand's own session. Being logged in helps: TikTok Creative Center gives the full hashtag list to logged in users and only three tags otherwise.
- Reddit's json sits behind a js check now. When it says no, a hidden window loads reddit.com once on the same session to pass it, then the json works.
- Google Trends answers 429 until the session has its cookie, so the first 429 grabs one and retries once. Rising queries are worldwide, last 7 days.
- YouTube without a key reads the search page (this week, sorted by views). Some niches only get a few results that way. With a Data API key in Settings it uses the API instead.
- TikTok hashtags are kept if they match a keyword. If none match, you get the general list with its score halved so it doesn't take the top three.
- Growth score: per source, velocity on a log scale against that source's best item, 0 to 100. Velocity is upvotes plus 2x comments per hour for Reddit, views per hour for YouTube, Google's own % rise for search, weekly views per hour for TikTok.
- Top three is the three highest scores, ties broken by raw velocity. The feed below skips them unless you filter or change the sort.
- Trend lines: TikTok sends its own 7 day curve. The rest start at zero when posted and gain a point every refresh, so they fill in over time.
- Only the first 5 keywords and 8 subreddits are used per refresh to stay under rate limits.
- Cache is one json per brand in `trends/` in the user data folder. Auto refresh checks the open brand every 10 minutes and refreshes when the cache is over 3 hours old.
- Links open in your normal browser. Thumbnails aren't loaded, the app never pulls remote images.
- Ideas is a plain list per brand for now. Saving the same link twice does nothing.
