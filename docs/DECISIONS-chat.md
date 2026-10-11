# Decisions: chat

Calls made while building the chat, so nobody has to guess later.

## Layout

- Chat is the home screen now. It's the first item in the sidebar and the app opens on it.
- The full view has the chat list on the left and the conversation in a centered column. On every other page the old right side pane is still there, it's the same chat in a narrow layout. Its title opens the chat list.
- The side pane is hidden on the chat page itself, two copies of the same chat next to each other is just noise.
- The side pane opens your last chat, the full view starts on a new one with a few starter prompts.
- Agents are added and edited from the agent picker in the composer ("Add or edit agents..."), not in Settings. Settings is being reworked on another branch and this keeps the merge clean. A button in Settings that opens the same modal is an easy follow up.
- `components/ChatPane.tsx` isn't used anymore but I left it in, delete it once this is merged.

## Agents

- Builtin agents: Claude Code, Codex, Cursor (`agent`), Grok Build, OpenCode, Antigravity (`agy`), Qwen Code and Kimi. They're found by looking on PATH plus a few usual install folders, since apps started from the dock or start menu don't always get the shell's PATH. Nothing gets run to detect them.
- Detection runs once when the chat opens. "Check again" looks again.
- Every message is one headless run. The agent gets the brand context, the chat so far and the new message in one prompt, nothing is kept between runs by the agent itself. Old turns get dropped first once the chat passes about 14k characters.
- Claude Code runs with `--tools ""` so it only writes text. Codex runs read-only. The others run in their print mode with their own defaults.
- Agents run in an empty folder (`agent-room` in the user data folder) so they don't go reading your files.
- Claude streams token by token through its json output. The rest stream whatever they print, some only print at the end.
- The prompt goes in on stdin when the cli supports it (Claude, Codex, OpenCode). The others get it as an argument, which is fine since nothing goes through a shell.
- Windows: npm installs clis as `.cmd` files, and node won't start those without a shell. The app reads the `.cmd` and runs the node script or exe inside it directly. If it can't, it only falls back to a shell when the prompt goes in on stdin, so the message never ends up on a command line cmd.exe would parse.
- Stop kills the whole process tree. A run that goes past 10 minutes gets stopped.
- One reply at a time per chat. You can have replies going in different chats at once.
- Custom agents: a command or an OpenAI-compatible API (base URL, model, key). Commands run without a shell, `{prompt}` in the command gets swapped for the prompt, otherwise it goes in on stdin. Presets fill in DeepSeek, GLM, OpenRouter and Ollama URLs, model names can be changed.
- Custom agents live in `agents.json` in the user data folder, not `trenddeck.json`. API keys are encrypted with the OS keychain (Electron safeStorage) when it's available and never go back to the window, the form only knows if one is saved.
- The agent you pick sticks to that chat and becomes the default for new ones.

## What the agent sees

- Brand name, keywords, subreddits, site tab names, the top 12 trends from the trends cache (title, source, score, one line of detail) and up to 15 saved idea titles.
- Never cookies, logins or anything from inside a site tab. The trends come from the cached file, building the prompt never fetches anything.
- Nothing runs in the background. An agent only starts when you send a message.

## History

- Chats are saved per brand in `chats/<brand id>.json`, owned by the main process. That way a reply that's still streaming gets saved even if you switch brands or close the pane. It saves every few seconds while streaming and once at the end.
- A reply that was still streaming when the app closed shows as stopped next time.
- Chats saved on the brand in `trenddeck.json` by the earlier pane get copied over the first time a brand's chat file is made. The old copy stays where it was.
- Deleting a brand stops its replies and deletes its chat file.

## Cards in the chat

- The agent can deal cards into a reply with a fenced code block in the language `trenddeck` holding one json object. The format is explained to it in every prompt.
  - `{"type":"trend","id":"reddit:abc"}` looks the trend up in the cached feed. It can also carry `title`, `url`, `source` and `score` for trends that aren't in the feed.
  - `{"type":"idea","title":"...","notes":"..."}` with a Save idea button.
  - `{"type":"draft","platform":"x","title":"...","body":"..."}` with Copy, Save idea and a button that opens the matching site tab.
  - `{"type":"site","site":"Reddit","url":"..."}` opens that site tab. The url only gets used if it's on the same site as the tab, otherwise the tab opens on its own page.
- Cards next to each other get dealt into one row. A card still streaming in shows as a blank card.
- Agents often put real line breaks inside json strings, so those get escaped before giving up. A block that still can't be read shows as plain text.
- Cards are 5:7 with the rising line mark in two corners, pink when the trend is hot. Drafts are wider so the text fits. The only bounce is the pop when you save an idea.
- Saving an idea only keeps the title, the idea type has no notes field yet.

## Markdown

- A small renderer in `chat/Markdown.tsx` builds react elements, never raw html. Headings, lists, quotes, tables, code blocks with a copy button, links. Links only open if they're http or https, in your normal browser.
