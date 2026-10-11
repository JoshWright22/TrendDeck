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
- Run the app from source with `--mcp-dev` to open one turn for the open brand and print the url, token and config path. It only works when the app isn't packaged. It's for trying the tools by hand without an agent.

## Permissions

- Every site is off for agents until you turn it on in Settings > Agent access, per brand.
- The share button in a site's toolbar shares that site with the next chat message only. The next turn for that brand takes it and it's gone after.
- Access is checked on every action against the url the tab is on right then, not the site it started on. A site matches its own host and its subdomains, and the most specific site of the brand wins. So if YouTube is on and YouTube Studio is off, `studio.youtube.com` stays off.
- Grants, revokes, shares and every agent action are logged per brand (last 500). The log keeps the kind of action, the site and a short detail like a path or a character count. It never keeps page text or what was typed.
- Grants live in `<user data>/mcp/state.json`, not in `trenddeck.json`, so the ui saving brand data can't wipe them. Deleting a brand drops its grants, log, drafts and post requests.
- `list_brands` only shows the brand the chat is for. Other brands are just counted, so one brand's chat can't leak the others' names, keywords or sites.

## Tabs

- The open tab is the site webview that's on screen. Sites you left stay mounted but hidden, those don't count. Its brand comes from its session, its site from its url.
- `read_page` returns headings, the visible text (up to 15000 characters) and numbered refs for things you can click or type into. Its scripts run in an isolated world so the page can't see them.
- Field values only show for plain text boxes. Passwords, hidden fields, card fields and one-time codes never show, and `type` refuses them.
- Clicks and typing go through real input events, so sites treat them like a person.
- `open_site` only works on the brand that's on screen. If you switched brands mid answer it says so instead of pulling you back.
- `upload_file` takes media library ids from `list_media`, only files allowed for agents. See DECISIONS.md. It sets the files with the devtools protocol, so the file input has to be on the page (they show in `read_page` even when hidden).
- No cookie, storage, password or script tool. There is no way for an agent to run its own code in a page.

## Post buttons

- `click` refuses a site's own post, publish or send control and tells the agent to use `request_post`, which goes through the post check. `read_page` marks those controls so the agent knows up front.
- What counts: a button, link or menu item whose label starts with post, publish, send, share, tweet, reply, repost, retweet, comment, submit, schedule or upload and is four words or less. X's own post and send buttons by their test ids. A submit button in a form that has a text area or a rich text box, like a comment or message form.
- It checks the element you asked for, the element really under its middle, and the button or link that one sits in. So clicking a wrapper around a Send button is blocked too.
- `type` with `submit` refuses to press Enter in a text area or rich text box, or in a form whose submit is one of those buttons. Typing without Enter still works, and Enter in a plain search box still works.
- Every refusal goes in the activity log as denied.
- It errs on the safe side. "Share" that only opens a share menu and "Reply" that only opens a reply box are blocked too. YouTube's last upload button says "Save" for private videos, that one isn't caught by the words, but uploads go through `request_post` anyway.
- Tried on a local test page with a plain Post button, a Send button inside a clickable wrapper, an X style post button, a comment form and a search form. Only Load more, the search and Find went through.

## Ideas, drafts and posts

- `save_idea` goes through the ui, which adds the idea to the brand like any other. Saving the same title and link twice does nothing.
- Drafts and post requests live in the MCP state file for now. There's no Writer or Schedule yet, so `list_schedule` shows post requests (with the time the agent suggested) and drafts.
- `request_post` puts a real post in the Posting queue. It waits in the brand's tab for you to press Post unless the brand skips the post check. See DECISIONS.md.

## Saved logins and `login`

- One login per brand and site, in `<user data>/vault/logins.json`. Username, password and notes go into one safeStorage blob together. Only the sign-in page link and the save time are plain.
- On Linux, safeStorage says it works even with no keyring and uses a fixed key. That isn't real locking, so `basic_text` and `unknown` count as unavailable and saving is refused.
- The ui can save, replace and delete, and gets back the username. Notes are locked like the password and never come back either, since people put backup codes in there. There's no ipc call that returns a password, and only the app window can call the vault, never a site tab.
- `login` needs the site to be allowed, same as `open_site`. Its answer is one status out of `logged_in`, `already_logged_in`, `needs_code`, `needs_user`, `no_saved_login`, `failed`. A short note rides along only when the site is unknown, not allowed, or a login is already running.
- Which sign-in page: the one saved with the login, or a built-in one for Reddit, X, Instagram, TikTok and YouTube, or the site's home page. On a page with no form the app clicks a "Log in" or "Sign in" link once. If there's still no form and the url doesn't look like a sign-in page, it's `already_logged_in`.
- Finding fields: password is a visible `type=password` box. Username is a visible text box whose name, label, placeholder or autocomplete says user, email, login, phone or account, or the only text box next to the password. Code boxes are `one-time-code` or named like otp, 2fa or verification, or a row of 4 to 8 one character boxes.
- Two step forms: fill the username, press Next, wait for the password box, fill it, submit. If the password box comes back after we sent it, the password was wrong and it's `failed`. Two or more password boxes means a sign-up or change password form, that's `needs_user`.
- Typing is real key input (`insertText`) into a field the app clicked and focused itself, then the app checks the length landed. The password never goes into a script string.
- A saved login is only typed on the site's host, its subdomains, the built-in sign-in host (accounts.google.com for YouTube) or the host of the sign-in page you saved. A redirect anywhere else stops the login.
- Captcha iframes or boxes on screen mean `needs_user`. The small reCAPTCHA badge doesn't count.
- On a code page the app shows its own dialog and waits up to 3 minutes. The tool call waits with it, then answers with the final status. Cancel or no answer is `needs_code`. A second code page in a row is `needs_user`.
- Every attempt goes in the vault's own log (last 300) and in the agent activity log as `login` with the result as the detail.
- Google and some others often refuse sign-in from embedded browsers. That shows up as `needs_user` or `failed`, the user signs in by hand once and the session sticks.

## Sign-in page guard

- A tab counts as a sign-in page when its url looks like login, sign-up, password, reset, two-factor, verify or challenge, the host starts with accounts., login., auth. and so on, or a password or code box is on screen.
- On those pages every tab tool (`read_page`, `click`, `type`, `scroll`, `upload_file`) gives back only `status: sign_in_page`. While a login is running on the brand's tab they give back `status: login_running`.
- `read_page` never shows what's in a text box anymore, on any page, only `(has text)`. Agents that need to edit a box can clear it and type again.
- Code boxes count as private fields like passwords, so `type` refuses them everywhere.
- The guard errs on the safe side. A page with "verify" in its path is blocked even if it's harmless.

## Update check

- The updater lives on main. This branch adds `autoUpdate` to settings so the saved file keeps it (the store dropped anything but the YouTube key) and an "Update automatically" switch in Settings. Missing means on.

## Shared files touched

- `src/main/index.ts`: start the MCP setup, drop a brand's agent data when the brand is deleted.
- `src/preload/index.ts`, `src/preload/index.d.ts`: a separate `window.trenddeckMcp` api. Also added the missing `platform`, `windowControl` and `onMaximized` to the main api, the build failed without them.
- `src/renderer/src/App.tsx`: share button next to the chat toggle, open-site and idea events.
- `src/renderer/src/components/SettingsModal.tsx`: the Agent access section.

For saved logins:

- `src/main/index.ts`: `setupVault()`, and deleting a brand drops its saved logins.
- `src/main/mcp/tools.ts`: the sign-in page guard in `allowedTab` and the `login` tool in the list.
- `src/main/mcp/tabs.ts`: `read_page` hides text box values, code boxes count as private.
- `src/main/store.ts`, `src/shared/types.ts`: `settings.autoUpdate`.
- `src/shared/mcp.ts`, `src/renderer/src/components/mcp/AgentAccess.tsx`: `login` in the activity log.
- `src/preload/index.ts`, `src/preload/index.d.ts`: `window.trenddeckVault`.
- `src/renderer/src/App.tsx`: mounts the code dialog.
- `src/renderer/src/components/SettingsModal.tsx`: Saved logins section and the Update automatically switch.
