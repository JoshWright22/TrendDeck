# TrendDeck

A desktop marketing app for creators. Each brand you run gets its own workspace with every site you post on open in a tab and already logged in.

Free and open source, MIT licensed.

![screenshot](docs/screenshot.png)

*screenshot goes here once the app has a bit more in it*

## What it does

Built so far:

- **Brand rail** on the left. Add, rename and delete brands. Right click a brand to edit it.
- **Separate logins per brand.** Every brand has its own browser session, so two brands can be logged into two different accounts on the same site and they never mix.
- **Site tabs.** Each site is a live page that stays logged in between runs. Starts with Reddit, X, Instagram, TikTok, YouTube, YouTube Studio, vidIQ and 1of10. Add your own with a name and a URL, remove the ones you don't use, drag tabs to reorder.
- **Back, forward, reload and home** on every tab.
- **Niche keywords** per brand. Nothing reads them yet, the Trends page will.
- Everything is saved locally in one JSON file. No account, no server.

Planned:

- **Trends**: what's picking up in your niche
- **Ideas**: post and video ideas from the trends you save
- **Schedule**: a calendar of what goes out where
- **Writer**: titles, captions and scripts
- **Analytics**: how your posts did across sites
- **Chat**: a side pane to ask about any of the above

Those pages are in the nav already but only say "coming soon".

## Install

You need [Node.js](https://nodejs.org) 22.12 or newer.

```
git clone https://github.com/JoshWright22/TrendDeck.git
cd TrendDeck
npm install
```

`npm install` also downloads Electron, so the first one takes a minute.

## Dev

```
npm run dev
```

Opens the app with hot reload.

```
npm run build
```

Type checks and builds into `out/`. `npm start` runs that build.

There's no installer yet, for now you run it from source.

## Where your data lives

Brands and sites are in `trenddeck.json` in the app's user data folder:

- Windows: `%APPDATA%\TrendDeck`
- macOS: `~/Library/Application Support/TrendDeck`
- Linux: `~/.config/TrendDeck`

Logins are in the same folder under `Partitions`, one folder per brand. Deleting a brand wipes its logins too.

## Layout

```
src/main       electron main process, window setup and the json store
src/preload    the small api the ui is allowed to call
src/renderer   the react ui
src/shared     types used by both sides
```

## License

MIT, see [LICENSE](LICENSE).
