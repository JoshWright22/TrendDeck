# Privacy

TrendDeck has no account, no server and no analytics. Everything it knows sits in one folder on your computer. This page lists what's in there, and every time something goes out over the network.

## Where it lives

All of it is in the app's user data folder:

- Windows: `%APPDATA%\TrendDeck`
- macOS: `~/Library/Application Support/TrendDeck`
- Linux: `~/.config/TrendDeck`

| What | File | Notes |
|---|---|---|
| Brands, keywords, subreddits, sites, ideas, settings | `trenddeck.json` | plain json, not encrypted |
| YouTube Data API key, if you set one | `trenddeck.json` | plain text, same as above |
| Logins and site data for each brand | `Partitions/brand-<id>/` | cookies, local storage and cache, kept by Chromium the same way a browser keeps them |
| Trends cache | `trends/<brand id>.json` | the last feed per brand |
| Ad block lists | `adblock-engine.bin` | public filter lists, nothing about you |
| Agent access | `mcp/state.json` | which sites agents may use, the activity log, drafts and post requests |
| Agent attach files | `mcp/*.json`, `mcp/bridge.cjs` | config for one chat message, deleted when it's done |
| Saved logins | `vault/logins.json` | username, password and notes locked with your system keychain, plus the sign-in log |
| Chats | `chats/<brand id>.json` | every chat with your agents, plain json |
| Your own agents | `agents.json` | commands and API urls, API keys locked with your system keychain when it's there |
| Agent limits | `agent-usage.json` | the usage limits an agent last reported |
| Agent folder | `agent-room/` | an empty folder agents run in so they don't read your files |
| Brand voice | `voice/<brand id>.json` | your profile and past posts |
| Inbox | `inbox/<brand id>.json` | comments read from your accounts, read marks and spam filters |
| Media library | `media/<brand id>.json`, `media/<brand id>/` | file list, thumbnails and copies you asked for |
| Posting | `posting.json`, `posting-keys.json` | queue, log and settings, API keys locked with your system keychain when it's there |
| Posting pace | `reuse-pace.json` | daily limits and gaps per site |

Deleting a brand deletes its logins, its saved logins, its trends cache, its agent access data, its chats, its voice, its inbox, its media library and its posts. Deleting the folder deletes everything.

## What goes out, and when

Nothing goes out unless it's one of these.

- **Sites you open.** A site tab is a normal browser tab in that brand's session. The site sees what it would see in any browser.
- **Trends.** When the Trends page loads, or every 10 minutes while the app is open if the open brand's feed is over 3 hours old, the app asks Reddit, YouTube, Google Trends and TikTok for your keywords and subreddits. It uses the brand's own session, so if you're logged in those sites see the searches on your account. With a YouTube key set, the key goes to Google with the YouTube requests. TikTok's general list is fetched even with no keywords. There's no switch to turn trends off yet.
- **Update check.** A few seconds after the app starts and every 6 hours, it asks GitHub for the latest version file. That's the whole request, nothing about you or your brands goes with it. If there's a new version it downloads from GitHub and installs when you quit. Turn off Settings > Update automatically and it never checks. Running from source never checks.
- **Ad block lists.** About once a day the app downloads the public ad and tracker lists. The request has no data about you or your brands.
- **Links.** Clicking a trend, idea or chat link opens it in a tab inside the app on that brand's session.
- **Spellcheck on Linux.** Chromium downloads its spellcheck dictionary from Google the first time you type in a text box. On Windows and macOS it uses the system spellchecker and nothing is downloaded.
- **Brand voice import, inbox and analytics refresh.** Only when you press Import or Refresh. The app opens your own pages on those sites in a hidden window on the brand's session and reads them.
- **Shorts import.** Only when you press it. The app loads your channel's Shorts page on the brand's session.
- **Chat.** When you send a chat message, the agent you picked gets your message and works through its own provider, the same way it does in a terminal. What it can see through TrendDeck is below.

The app never loads remote images or fonts for its own screens, has no crash reporter.

## What agents can see

Agents only run when you send a chat message, and only for the brand that chat is for.

- **Always:** the brand's name, keywords, subreddits and site list, its trends, ideas, drafts and post requests.
- **Only on sites you allowed:** the open tab's url, title, visible text and a list of buttons, links and text boxes. What's typed in a text box is never shown, only that it has something in it. A site is allowed when you turn it on in Settings > Agent access, or share the tab for one message with the share button in the toolbar. You can turn it off any time and every action shows in the activity log.
- **Never:** cookies, local or session storage, your saved logins, password, card and code fields, other brands, or anything on a site you didn't allow.
- **On sign-in pages:** nothing. While a tab is on a login, sign-up, password or two-factor page, agents only get told it's a sign-in page and can't click or type there.

Anything an agent reads goes to that agent's provider as part of answering you. If a page shows something private, like DMs or an email, and you allowed that site, the agent can read it. Allow only the sites you want it working in.

Agents can't post for you. `request_post` puts a post in "Waiting for you" in Settings > Agent access and you post it yourself.

## Saved logins

You can save one login per brand and site in Settings > Saved logins. Nothing is saved until you add one.

- The username, password and notes are locked with your system keychain. That's the Windows user account key, the macOS Keychain, or GNOME Keyring/KWallet on Linux. The file is useless on another computer or another user account.
- If the keychain isn't there, TrendDeck won't save the login and tells you why. On Linux with no keyring that's always the case.
- After you save a password the app never shows it again, settings only show the username. You can replace it or delete it.
- When an agent calls `login`, the app opens the sign-in page in the brand's tab and fills it itself. The agent only gets back how it went: signed in, already signed in, needs a code, needs you, no saved login or failed. It never sees the username, password or code.
- If the site asks for a two-factor code, the app asks you in its own window and types it in. The code doesn't go to the agent.
- A saved login is only typed into its own site, or the sign-in page you set for it. Anywhere else the app stops.
- Every sign-in is logged with the site, time and result, never the login itself. The log is in Settings > Saved logins.

## The local agent server

During a chat message the app runs a small server for the agent on `127.0.0.1`. It only answers this computer, needs a token that's new for every message and dies when the answer is done, and turns away anything coming from a web page.

## Fixed in this audit

- `list_brands` gave a chat's agent every brand's keywords and sites. It now only shows the brand the chat is for.
- Agent attach files with tokens are removed when a message is done and swept on startup if the app crashed.
