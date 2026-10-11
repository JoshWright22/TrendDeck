# Decisions

Calls made while building, so nobody has to guess later.

## Layout

- Brand switcher is a row of small brand cards in the title bar, not a dropdown. Every brand stays one click away and the shortcut number shows on hover.
- The app always opens on the chat. What each brand has open isn't saved, only kept while the app runs.
- Sites you visit stay loaded after you leave them, hidden with CSS so switching back is instant. Each brand keeps its 6 most recently used ones, the oldest gets closed when you open a 7th. The number is in Settings > Tabs, 1 to 20. A closed one reopens on the last page you were on, it just reloads.
- Other brands keep their tabs too, so switching brands and back is instant as well. That's more memory with a lot of brands, the cap is per brand to keep it simple.
- Hidden, not `display: none`. A webview that loses its size has to lay the page out again when it comes back, which is the delay this is meant to remove. Webviews never move in the page either, moving one reloads it.
- A hidden tab is muted, its videos get paused, and it stops painting. After 5 minutes out of view it's frozen so its scripts stop too, and it wakes up the moment you open it. Pages with "studio" or "upload" in the address are never frozen so an upload keeps going.
- After 4 seconds without input the brand's first 3 sites load in the background, one at a time 8 seconds apart, so the usual ones are ready before you click. Only into free slots, it never closes a tab you used to make room. Each site is only warmed once per run.
- Switching back to a site went from about 580 ms before anything showed and 8 s until the page finished loading, to about 25 ms with nothing to load. Four sites open went from 1.4 GB to 1.9 GB of memory, that's the trade.
- Ctrl+1..9 (Cmd on macOS) picks the brand in rail order. When a site has focus the main process catches the keys first, otherwise the site would eat them.
- Chat is the home screen and the first item in the sidebar. On every other page it can sit on the right too, toggled from the top right. See DECISIONS-chat.md.
- On the chat the main area drops its panel box, so the sidebar, the chat list and the conversation sit on one felt with one spotlight. Every other page keeps the raised panel, that's how you can tell you left home.
- Pages and the chat pane are lazy loaded, each one is its own chunk.
- Fonts (Inter, Inter Tight) come from @fontsource and get bundled, latin subset only to keep the build small.

## Startup

- The ad blocker library and its engine load one second after the window first paints. Before that nothing has opened a site yet, so nothing slips through in practice.
- The lists only download and rebuild when the cached engine is over 4 hours old. Before, every start downloaded all of them and rebuilt the engine, which kept the cpu busy right when the window was trying to show.
- A stale trends cache waits until 5 seconds after launch to refresh, the cached feed shows meanwhile.
- The updater module only loads in the installed app.
- The ui bundle is minified now (698 kB to 248 kB) and the modals and setup screen are their own chunks.
- Measured on a busy test machine, median of 5 runs each: start to first paint went from 6.3 s to 4.6 s, memory 3 seconds after start from 1018 MB to 535 MB. After 30 seconds it's about the same either way (790 to 900 MB) since that's when the warmed sites and trends fetch land.
- Most of what's left of the start is the gpu process coming up. With `--disable-gpu` the first paint lands in about 1.3 s, but then sites scroll and play video on the cpu, which is worse on a slow machine. So it stays on.

## First run

- A fresh install opens on a short setup instead of the app: name your brand and niche, pick your sites, done. Three dots show where you are. Skip keeps the default "My Brand" with every site.
- Data from before setup existed counts as done, so nobody who already uses the app sees it.
- The niche is one comma separated field there to keep it short. Settings has the full keyword editor and subreddits.
- Nothing warms up in the background while setup is open.

## Settings

- Settings is a screen in the main area, not a modal, with a section list on the left: Brand, Sites, Ad blocker, Tabs, Trends, About. Trends holds the YouTube key, it didn't fit anywhere else.
- Changes save as you make them, there's no Save button. Text fields save when you leave them or press Enter.
- Brand and Sites are for the open brand. The ad blocker lists every brand with the open one first, same as before.
- Default sites you removed show up under Sites as one click buttons to add them back.
- About has the version from package.json, the repo link (opens in a tab like every other link) and the switch for updates. The updater already read that setting but the store used to drop it, so it couldn't be turned off before.

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

- Sites only play sound while you can see them. Minimize or hide the window and every site goes quiet, it comes back on restore. A site tab that's open in the background stays muted until you go back to it.
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
- Media came in after posting. It sits between Ideas and Schedule like its branch had it, Posting stays last.
- MCP and saved logins came last. Agent access and Saved logins sit at the bottom of Settings under the ad blocker. The branch's update switch is kept since main's updater already reads `settings.autoUpdate`. The share button sits next to the chat toggle in a site's toolbar.
- The feature decisions stay in their own files: DECISIONS-ideas.md, DECISIONS-writer.md, DECISIONS-posting.md, DECISIONS-media.md, DECISIONS-mcp.md, DECISIONS-chat.md, DECISIONS-voice.md, DECISIONS-inbox.md, DECISIONS-reuse.md and DECISIONS-emulator.md.
- The newer shell from main came in after that: live tabs, first run setup and the Settings screen. The settings modal is gone. Agent access and Saved logins are sections on the Settings screen between Trends and About, they get the section title from the screen so their own headings went. The branch's own "Update automatically" switch is dropped, About already has one for the same setting.
- With live tabs more than one site webview is mounted, so the agent tools can't take the first one anymore. The open tab is the one that told main it's on screen. A tab that's still mounting doesn't count until its page is up, and `waitForTab` already waits for that. With a page like Trends on screen there's no open tab, same as before.
- An agent or the post check opening a site that's already loaded in the background sends that tab to the link, like any other link does. Before, it only set the start url, which a loaded tab never reads again.
- Chat came next. Its view replaced the old chat pane, so `ChatPane.tsx` is gone. A site card in the chat sends a tab that's already loaded to the card's link too. Searching trends from the title bar opens Trends, not home, since home is the chat now.
- Agents got a section on the Settings screen next to Agent access. It lists the agents found and opens the same editor as the composer's agent picker.
- Brand voice came after chat. It sits right under Ideas in the sidebar, before Media. Its "Learn my voice" draft goes into the chat composer through the same `onDraft` hook, now in `ChatView.tsx` since the old pane is gone.
- Inbox came next and sits last in the sidebar, after Posting. The login dots from its account check show next to each site in the sidebar.
- Shorts came next, between Posting and Inbox. It was built when posts still took a file path, so it picks its video with the Media picker now and its posts carry the media id. The length and size check reads the file in main from the id, the page never sees the path.
- Posting pace is its own section on the Settings screen. The branch's "What TrendDeck stores" list was dropped, it was missing half the files. docs/PRIVACY.md has the full list and got the files from chat, voice, inbox, media, posting and Shorts.
- The phone came last. Its Phone entry sits under the site list in the sidebar like its branch had it. The branch still had `adblockAttach` and `onAdblockCount` from the old ad blocker, those are gone again.
- Hooking the chat to the agent server: every cli and command agent run is one turn, opened right before the process starts and ended when it exits. Tested with a small command agent that reads its env, lists the tools with the token, and the same token gets a 401 once it's done. The real clis weren't run for this.
- Every place you pick a file now goes through the Media picker: the post composer and Shorts already did, the chat composer does too. Chat attachments are media ids, see DECISIONS-chat.md.
- The writer's agent button drafts a chat message now instead of calling an agent. The old hook the chat was meant to plug into is gone. See DECISIONS-writer.md.
- No native selects or menus are left. Every page uses the themed `Dropdown` and `Menu` from `chat/ui`, and the css that only styled the old selects is gone.

## One session per brand

- Everything a brand does runs on its one saved session, `persist:brand-<id>`: site tabs, temporary tabs, login popups, the hidden trend and analytics windows, the posting window and the self-check. Log into a site once in any of them and the rest are logged in too.
- Checked by setting a cookie in a site tab and reading it from a popup the tab opened. Same cookie.
- YouTube's API sign in used to open in the system browser, which isn't the brand's session, so you'd sign into Google twice. It opens in a small window on the brand's session now.
- The posting window used to block every popup, so a login popup there went nowhere. It treats popups like a site tab does now: sized ones open on the same session, links are blocked.
- The token swaps and API calls for posting and analytics keys don't use a session. They aren't logins, they carry their own key.

## Media, agents and the post audit

- Posts keep a media library id, not a path. The composer picks files with the Media picker and the old file dialog is gone. Main turns the id into a path with `resolveForUpload` right before a post runs, for both tabs and api mode, and the file has to be in the post's own brand. Once a post goes out the file gets marked posted in Media.
- Posts saved before this lose their file, they had a path and paths aren't accepted from the page anymore.
- The MCP `upload_file` tool takes media ids from a new `list_media` tool, never paths. It goes through `resolveForUpload` with `forAgent` on, so only files the user allowed for agents work. The old path checks are gone with it.
- `request_post` makes a real post in the Posting queue marked as from an agent, with an optional media id. Agent posts only get agent allowed files, checked when asked and again when it runs. The old "Waiting for you" list in Agent access stays for requests made before this.
- Post audit is the default for every post, yours or an agent's. The app switches to the brand and its tab for the site, fills the post in there and waits at Post. Leaving the tab counts as closing the review.
- Skipping the audit is the per brand "Press Post for me" setting from posting, renamed "Skip the post check", still off by default. With it on posts run in a background window like before so they don't take over your tab.
- If the brand has no tab for the site, or the tab doesn't come up in 15 seconds, the audit falls back to the separate posting window on the same session. It still stops at Post.
- Agents can't press a site's own post, publish or send button through the page tools anymore, so every post an agent makes goes through `request_post` and the post check. See DECISIONS-mcp.md.
