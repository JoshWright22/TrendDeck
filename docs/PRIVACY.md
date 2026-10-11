# Privacy

TrendDeck has no account, no server and no analytics. Everything it knows sits in one folder on your computer. This page lists what's in there, and every time something goes out over the network.

## Where it lives

All of it is in the app's user data folder:

- Windows: `%APPDATA%\TrendDeck`
- macOS: `~/Library/Application Support/TrendDeck`
- Linux: `~/.config/TrendDeck`

| What | File | Notes |
|---|---|---|
| Brands, keywords, subreddits, sites, ideas, chat threads, settings | `trenddeck.json` | plain json, not encrypted |
| YouTube Data API key, if you set one | `trenddeck.json` | plain text, same as above |
| Logins and site data for each brand | `Partitions/brand-<id>/` | cookies, local storage and cache, kept by Chromium the same way a browser keeps them |
| Trends cache | `trends/<brand id>.json` | the last feed per brand |
| Ad block lists | `adblock-engine.bin` | public filter lists, nothing about you |
| Agent access | `mcp/state.json` | which sites agents may use, the activity log, drafts and post requests |
| Agent attach files | `mcp/*.json`, `mcp/bridge.cjs` | config for one chat message, deleted when it's done |

Deleting a brand deletes its logins, its trends cache and its agent access data. Deleting the folder deletes everything.

## What goes out, and when

Nothing goes out unless it's one of these.

- **Sites you open.** A site tab is a normal browser tab in that brand's session. The site sees what it would see in any browser.
- **Trends.** When the Trends page loads, or every 10 minutes while the app is open if the open brand's feed is over 3 hours old, the app asks Reddit, YouTube, Google Trends and TikTok for your keywords and subreddits. It uses the brand's own session, so if you're logged in those sites see the searches on your account. With a YouTube key set, the key goes to Google with the YouTube requests. TikTok's general list is fetched even with no keywords. There's no switch to turn trends off yet.
- **Ad block lists.** About once a day the app downloads the public ad and tracker lists. The request has no data about you or your brands.
- **Links.** Clicking a trend or idea link opens it in your normal browser.
- **Spellcheck on Linux.** Chromium downloads its spellcheck dictionary from Google the first time you type in a text box. On Windows and macOS it uses the system spellchecker and nothing is downloaded.
- **Chat.** When you send a chat message, the agent you picked gets your message and works through its own provider, the same way it does in a terminal. What it can see through TrendDeck is below.

The app never loads remote images or fonts for its own screens, has no crash reporter and no auto update.

## What agents can see

Agents only run when you send a chat message, and only for the brand that chat is for.

- **Always:** the brand's name, keywords, subreddits and site list, its trends, ideas, drafts and post requests.
- **Only on sites you allowed:** the open tab's url, title, visible text and a list of buttons, links and text boxes. A site is allowed when you turn it on in Settings > Agent access, or share the tab for one message with the share button in the toolbar. You can turn it off any time and every action shows in the activity log.
- **Never:** cookies, local or session storage, saved passwords, password and card fields, other brands, or anything on a site you didn't allow.

Anything an agent reads goes to that agent's provider as part of answering you. If a page shows something private, like DMs or an email, and you allowed that site, the agent can read it. Allow only the sites you want it working in.

Agents can't post for you. `request_post` puts a post in "Waiting for you" in Settings > Agent access and you post it yourself.

## The local agent server

During a chat message the app runs a small server for the agent on `127.0.0.1`. It only answers this computer, needs a token that's new for every message and dies when the answer is done, and turns away anything coming from a web page.

## Fixed in this audit

- `list_brands` gave a chat's agent every brand's keywords and sites. It now only shows the brand the chat is for.
- Agent attach files with tokens are removed when a message is done and swept on startup if the app crashed.
