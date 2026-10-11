![TrendDeck](docs/banner.png)

# TrendDeck

TrendDeck is a marketing desktop for creators. Every brand you run gets its own workspace: every account logged in at once, what's trending in your niche, and a chat pane that turns trends into posts.

Works with the AI subscriptions you already have: Claude Code, Codex, Cursor, Grok Build, OpenCode and Google Antigravity. If one is set up on your computer, TrendDeck can use it.

## "So what's the catch?"

There isn't one. I built TrendDeck because I run more than one brand and got sick of logging in and out of the same five sites all day, then digging through ten tabs to figure out what to post next. The paid tools that do pieces of this are slow, cost a monthly fee each, and don't talk to each other.

I wanted one app that's fast on a cheap laptop, keeps everything on your machine, and is fully open. If it ever goes the wrong way, fork it and build the one you want.

## What it does

Working now:

- **Brands.** A rail of brands on the left. Each one has its own logins, niche keywords and recommendations, and switching is one click.
- **Every account at once.** Each brand gets its own browser session, so two brands can be logged into two different accounts on the same site and they never mix.
- **Site tabs.** Reddit, X, Instagram, TikTok, YouTube, YouTube Studio, vidIQ and 1of10 to start. Add any site with a name and a URL, drag to reorder.
- **Local first.** Everything is saved on your computer. No account, no server.

Brand colors, type and logo rules are in [docs/BRAND.md](docs/BRAND.md).

Coming next:

- **Trends**: one ranked feed of what's rising in your niche across Reddit, YouTube, Google Trends and TikTok
- **Chat**: ask your AI agent (any of the six above) for ideas, outlines, titles and posts, with your brand and trends as context
- **Ideas and Schedule**: a board from idea to posted, and a calendar of what goes out where
- **Writer**: drafts for every platform from one idea
- **Analytics**: how your posts did, pulled from your own logged-in accounts
- **Posting**: TrendDeck posts for you through your logged-in tabs, or through official APIs if you'd rather
- **Ad blocker** built in, and a **phone emulator** for app-only features

## Installation

> [!NOTE]
> The chat features need at least one agent installed and logged in:
>
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: install the [Antigravity CLI](https://antigravity.google) and sign in with Google
>
> Everything else works without one.

There's no installer yet, so for now you run it from source. You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
git clone https://github.com/JoshWright22/TrendDeck.git
cd TrendDeck
npm install
npm run dev
```

The first `npm install` also downloads Electron, so it takes a minute.

## Development

```bash
npm run dev        # app with hot reload
npm run build      # type check and build into out/
npm start          # run the build
```

```
src/main       electron main process, window setup and the json store
src/preload    the small api the ui is allowed to call
src/renderer   the react ui
src/shared     types used by both sides
resources      logo and app icons
```

## Where your data lives

Brands and sites are in `trenddeck.json` in the app's user data folder:

- Windows: `%APPDATA%\TrendDeck`
- macOS: `~/Library/Application Support/TrendDeck`
- Linux: `~/.config/TrendDeck`

Logins live in the same folder under `Partitions`, one folder per brand. Deleting a brand wipes its logins too.

## License

MIT, see [LICENSE](LICENSE).
