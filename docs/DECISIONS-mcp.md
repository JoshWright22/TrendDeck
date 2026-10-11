# Decisions: agent tools (MCP)

Calls made while building the local MCP server, so nobody has to guess later.

## How it runs

- No SDK. MCP here is a handful of JSON-RPC methods (initialize, ping, tools/list, tools/call), so it's written by hand in `src/main/mcp/server.ts` and the app gets no new dependency.
- Plain HTTP on `127.0.0.1` with a random port. Every request needs a bearer token. Requests with an `Origin` header or a `Host` that isn't ours get a 403, so a web page can't reach it.
- Answers are plain JSON, no event stream. None of the tools need to stream.
- The server starts on the first chat turn and stays up after that. With no turn open every request gets a 401.
- Agents that only do stdio get `bridge.cjs`, a small script written to `<user data>/mcp/` and run with the app's own Electron in node mode. It passes each line to the HTTP server. No separate Node install needed.

## Turns

- A turn is one chat message being answered. The chat calls `beginAgentTurn(brandId, agent)` from `src/main/mcp` right before it starts the agent and calls `end()` when the agent exits. Nothing else opens a turn, so agents can only reach the app while answering the user.
- Each turn gets its own token, which dies when the turn ends. A turn left open by a crash dies after 30 minutes anyway.
- A turn is tied to one brand. Tools only act on that brand's tab and data.
- `beginAgentTurn` hands back the args and env to add to the agent's command:
  - claude: `--mcp-config <file> --allowedTools mcp__trenddeck`, HTTP with the token in a header. The tools skip claude's own prompt because the server checks site access itself.
  - codex: `-c mcp_servers.trenddeck.*` overrides that start the stdio bridge, token in the server's env.
  - opencode: `OPENCODE_CONFIG` pointing at a config with a remote server, token read from `{env:TRENDDECK_MCP_TOKEN}`.
  - anything else: `TRENDDECK_MCP_URL`, `TRENDDECK_MCP_TOKEN`, `TRENDDECK_MCP_STDIO` (the bridge command) and `TRENDDECK_MCP_CONFIG`, a standard `mcpServers` json with both stdio and http entries.
- Config files are written per turn, removed when it ends, and any leftovers are swept on startup.
- Run the app from source with `--mcp-dev` to open one turn for the open brand and print the url, token and config path. It only works when the app isn't packaged. It's there to try the tools by hand before the chat is wired up.

## Permissions

- Every site is off for agents until you turn it on in Settings > Agent access, per brand.
- The share button in a site's toolbar shares that site with the next chat message only. The next turn for that brand takes it and it's gone after.
- Access is checked on every action against the url the tab is on right then, not the site it started on. A site matches its own host and its subdomains, and the most specific site of the brand wins. So if YouTube is on and YouTube Studio is off, `studio.youtube.com` stays off.
- Grants, revokes, shares and every agent action are logged per brand (last 500). The log keeps the kind of action, the site and a short detail like a path or a character count. It never keeps page text or what was typed.
- Grants live in `<user data>/mcp/state.json`, not in `trenddeck.json`, so the ui saving brand data can't wipe them. Deleting a brand drops its grants, log, drafts and post requests.
- `list_brands` only shows the brand the chat is for. Other brands are just counted, so one brand's chat can't leak the others' names, keywords or sites.

## Tabs

- The open tab is the one webview the app has mounted. Its brand comes from its session, its site from its url.
- `read_page` returns headings, the visible text (up to 15000 characters) and numbered refs for things you can click or type into. Its scripts run in an isolated world so the page can't see them.
- Field values only show for plain text boxes. Passwords, hidden fields, card fields and one-time codes never show, and `type` refuses them.
- Clicks and typing go through real input events, so sites treat them like a person.
- `open_site` only works on the brand that's on screen. If you switched brands mid answer it says so instead of pulling you back.
- `upload_file` takes full paths to images, video, audio, pdf, txt, csv or subtitle files. Nothing from hidden folders or TrendDeck's own folder. It sets the files with the devtools protocol, so the file input has to be on the page (they show in `read_page` even when hidden).
- No cookie, storage, password or script tool. There is no way for an agent to run its own code in a page.

## Ideas, drafts and posts

- `save_idea` goes through the ui, which adds the idea to the brand like any other. Saving the same title and link twice does nothing.
- Drafts and post requests live in the MCP state file for now. There's no Writer or Schedule yet, so `list_schedule` shows post requests (with the time the agent suggested) and drafts.
- `request_post` never posts. It adds the post to "Waiting for you" in Settings > Agent access, where you can copy it, mark it posted or dismiss it.

## Shared files touched

- `src/main/index.ts`: start the MCP setup, drop a brand's agent data when the brand is deleted.
- `src/preload/index.ts`, `src/preload/index.d.ts`: a separate `window.trenddeckMcp` api. Also added the missing `platform`, `windowControl` and `onMaximized` to the main api, the build failed without them.
- `src/renderer/src/App.tsx`: share button next to the chat toggle, open-site and idea events.
- `src/renderer/src/components/SettingsModal.tsx`: the Agent access section.
