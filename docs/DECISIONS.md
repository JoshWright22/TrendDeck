# Decisions

Calls made while building, so nobody has to guess later.

## Layout

- Brand switcher is a row of small brand cards in the title bar, not a dropdown. Every brand stays one click away and the shortcut number shows on hover.
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
- Thumbnails aren't loaded, the app never pulls remote images.
- Saving the same link twice as an idea does nothing.

## Window

- No native frame on Windows and Linux. The title bar is ours: logo, brand cards, search, then minimize, maximize and close. The bar is a drag region so Windows still treats it as the caption, double click maximizes and dragging to an edge snaps. The snap layouts popup on hover over maximize is native only, so it's not there.
- macOS keeps its own traffic lights in a hidden title bar, people expect them there.
- Search in the bar is the one search box. It lists matching pages, sites, brands and ideas, and the first row searches trends. Picking that opens Trends filtered, with a chip to clear it. Pasting a link opens it in a tab. Ctrl+K focuses it.

## Motion

- Everyday motion is a short fade and slide with no overshoot. The bounce and the diamond burst only play on a small win: saving an idea now, a post going out once posting exists. `.win-pop` in styles.css is the one place it lives.

## Links

- Every link opens inside TrendDeck, never the system browser. Trends, ideas, pasted links and links a site wants in a new tab all go through the same path.
- A link goes to the brand's site tab with the same host, or the same domain if there's no exact match (youtube.com links go to YouTube, not YouTube Studio). If nothing matches it opens a temporary tab at the bottom of the Sites list.
- Temporary tabs aren't saved and go away when the app closes. The pin button keeps one as a normal site.
- Popups that ask for a size, like Google or Apple login, still open as a small window in the same brand session. They need the page that opened them to finish the login.

## Ad blocker

- On for every brand by default. There's no button or count in the main UI, it just works. Settings has the switch per brand and an allowlist of domains per brand, subdomains included. The old per site switch moved into the allowlist.
- Lists are the ones uBlock Origin turns on by default: its filters, quick fixes, unbreak, privacy and badware lists, plus EasyList and EasyPrivacy. They come from uBO's own CDN with two mirrors each, so one being down doesn't matter. Scriptlets (json-prune, set-constant and the rest) come from the resources file the blocker library builds from uBO's.
- Lists refresh when the app starts and every 4 hours. Each list is cached on disk, so a failed download keeps the last good copy. Parsing takes a few seconds so it runs in a worker thread, and the built engine is cached so the next start is instant.
- Scriptlets run from a preload at document start. The library's own way injects them after the page has started, which is too late for YouTube: the player has already read its ad slots by then. Each scriptlet runs in its own function because they all declare the same helpers.
- Login pages and YouTube Studio are never touched.
- Checked on a monetized music video: with the blocker on it plays from 0:00 with no pre-roll, with youtube.com on the allowlist a 15 second ad plays first.

## Sound

- Sites only play sound while you can see them. Minimize or hide the window and every site goes quiet, it comes back on restore. Only the open site has a webview anyway.
- `--mute-audio` or `TRENDDECK_MUTE=1` mutes everything, the app window, sites and popups. Test runs always use one of them.

## Agents

- An agent only runs when you send a chat message. Nothing else calls one: not trends, not the ad blocker, not analytics, not a timer. Anything that wants an agent's help has to go through a message you send.

## Merging the feature branches

- Ideas board and schedule, writer and analytics, and posting were built on an older commit and merged onto the new shell in that order. Each one keeps the shell from main and adds its pages to the sidebar and the page list.
- Each branch added `platform`, `windowControl` and `onMaximized` to the preload. Main already had them, so there's one copy.
- The writer branch still had `adblockAttach` and `onAdblockCount` from the old ad blocker. Main dropped those when the blocker moved to the session, so they're gone.
- The ideas board replaced `pages/Ideas.tsx` and the last stub page went away once every page was real, so `Stub.tsx` is gone too.
- Posting is the sixth page in the sidebar, after Analytics.
- Each feature kept its own rising line mark component instead of sharing the one in `Icons.tsx`. They draw the same mark, merging them can wait.
- The feature decisions stay in their own files: DECISIONS-ideas.md, DECISIONS-writer.md and DECISIONS-posting.md.
