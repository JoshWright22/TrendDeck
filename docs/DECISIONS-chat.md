# Decisions: chat

Calls made while building the chat, so nobody has to guess later.

## Layout

- Chat is the home screen now. It's the first item in the sidebar and the app opens on it.
- The full view has the chat list on the left and the conversation in a centered column. On every other page the old right side pane is still there, it's the same chat in a narrow layout. Its title opens the chat list.
- The side pane is hidden on the chat page itself, two copies of the same chat next to each other is just noise.
- The side pane opens your last chat, the full view starts on a new one with a few starter prompts.
- Agents are added and edited from the agent picker in the composer ("Add or edit agents...") or from Settings > Agents, which shows what was found and opens the same editor.

## Agents

- Builtin agents: Claude Code, Codex, Cursor (`agent`), Grok Build, OpenCode, Antigravity (`agy`), Qwen Code and Kimi. They're found by looking on PATH plus a few usual install folders, since apps started from the dock or start menu don't always get the shell's PATH. Nothing gets run to detect them.
- Detection runs once when the chat opens. "Check again" looks again.
- Every message is one headless run. The agent gets the brand context, the chat so far and the new message in one prompt. Claude is the exception, it resumes its session per thread (see Thread tools). Old turns get dropped first once the chat passes about 14k characters.
- Claude Code can only search the web and open pages (see the work log section). Codex runs read-only. The others run in their print mode with their own defaults.
- Agents run in an empty folder (`agent-room` in the user data folder) so they don't go reading your files.
- Claude, Codex and Cursor stream through their json output. The rest stream whatever they print, some only print at the end.
- The prompt goes in on stdin when the cli supports it (Claude, Codex, OpenCode). The others get it as an argument, which is fine since nothing goes through a shell.
- Windows: npm installs clis as `.cmd` files, and node won't start those without a shell. The app reads the `.cmd` and runs the node script or exe inside it directly. If it can't, it only falls back to a shell when the prompt goes in on stdin, so the message never ends up on a command line cmd.exe would parse.
- Stop kills the whole process tree. A run that goes past 10 minutes gets stopped.
- One reply at a time per chat. You can have replies going in different chats at once.
- Custom agents: a command or an OpenAI-compatible API (base URL, model, key). Commands run without a shell, `{prompt}` in the command gets swapped for the prompt, otherwise it goes in on stdin. Presets fill in DeepSeek, GLM, OpenRouter and Ollama URLs, model names can be changed.
- Custom agents live in `agents.json` in the user data folder, not `trenddeck.json`. API keys are encrypted with the OS keychain (Electron safeStorage) when it's available and never go back to the window, the form only knows if one is saved.
- The agent you pick sticks to that chat and becomes the default for new ones.

## What the agent sees

- Brand name, keywords, subreddits, site tab names, the top 12 trends from the trends cache (title, source, score, one line of detail) and up to 15 saved idea titles.
- The brand voice pack from `getBrandContext`, in every prompt. It gets the size set on the Voice page.
- The whole prompt stays under 30000 characters, since Windows caps a command line near 32k and some clis take the prompt as an argument. The brand part and the new message always go in. The voice pack gets its own size or what's left after those with 2000 kept for the chat so far, whichever is smaller. Earlier turns get the rest, up to the old 14k.
- Claude resumes its session, so it already has the voice from the first message. A resumed message only carries the pack again when it changed since that session last got it. A hash per agent sits on the thread for that and gets cleared with the session on retry and edit.
- Never cookies, logins or anything from inside a site tab. The trends come from the cached file, building the prompt never fetches anything.
- Nothing runs in the background. An agent only starts when you send a message.

## Agent tools

- Right before an agent process starts, the chat opens a turn on the app's agent server with `beginAgentTurn` and adds the args and env it hands back to the process. When the process exits the turn ends and its token stops working. See DECISIONS-mcp.md for what the tools can do.
- Claude, Codex and OpenCode get their own config. Every other cli and custom command agents get the generic env (`TRENDDECK_MCP_URL`, `TRENDDECK_MCP_TOKEN`, `TRENDDECK_MCP_CONFIG`, `TRENDDECK_MCP_STDIO`) and can use it or not.
- Claude already had `--allowedTools WebSearch,WebFetch`. The turn's `mcp__trenddeck` gets added to that same flag instead of a second one, so both lists count. `--strict-mcp-config` stays, so only the app's server comes along.
- A retry after a lost session reuses the same turn, it's still the same message.
- API agents don't get a turn. They're one request with no process and the chat doesn't do tool calls for them, so there's nothing that could use it.

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

- A small renderer in `chat/Markdown.tsx` builds react elements, never raw html. Headings, lists, quotes, tables, code blocks with a copy button, links. Links only open if they're http or https, and they open in a tab inside the app like every other link.

## Models

- Next to the agent picker there's a model picker. The pick is saved on the thread per agent, so switching agents and back keeps it, and it can change between any two messages.
- Clis don't have a way to list their models without starting a session, so the lists are fixed in `catalog.ts`. Claude gets its aliases (Opus, Sonnet, Haiku), Codex and Cursor get a couple of known names. Default always means let the cli pick. Clis with no known model flag only show Default.
- Api agents ask their `/models` endpoint when you open the picker. That only lists models, nothing gets sent to one. If it fails you get the model saved on the agent.

## Thinking and the work log

- Claude, Codex and Cursor run with their json output now and get parsed in `agents/parse.ts`. Thinking goes into a Thinking block, tool calls go into a work log (what it did, page or file or command, running/done/failed and how long), then the answer.
- Both blocks are open while they're what's happening and fold up when the answer starts. A click on either one sticks.
- Claude mostly doesn't send its thinking text, only a token count. Then the block says how long it thought and that it doesn't show the rest.
- Openai style apis: `reasoning_content` or `reasoning` in the stream counts as thinking.
- Everything else still streams plain text with the three dots.
- Claude can now search the web and open pages (`WebSearch,WebFetch` only, no shell or files). Without it the work log would always be empty. It runs with `--strict-mcp-config` so the user's own mcp servers don't come along.
- A line that isn't json in Codex or Cursor output goes through as text, so a cli version with a different format still shows something.

## Themed controls

- `chat/ui/` has `Dropdown` and `Menu` plus `usePopover`. Arrows, Home/End, Enter, Escape and type to jump all work.
- Every select in the app uses them now, not just the chat. `className="block"` gives a full width one that lines up with the text boxes in a form.
- A dropdown inside a `<label>` used to open again right after you picked, the label passed the click back to the button. Picking an option cancels that click now.
- The post composer's subreddit box had a native suggestion list. It's a "Yours" menu next to the box now with the brand's subreddits.

## Usage

- The gauge button in the composer shows the context this chat uses and each agent's limits.
- Context: the tokens the agent reported on its last reply, otherwise a guess from the text length (it says "about").
- Claude reports its 5 hour and weekly limits on every reply, those get saved in `agent-usage.json` and shown with when they were seen. Before the first reply it says unknown.
- Codex limits come from its own session logs in `~/.codex/sessions`, the newest file only.
- The rest say unknown. Opening the popover never runs an agent or sends anything.

## Thread tools

- Stop (button or Esc, see Esc below), Retry on the last reply, Edit on any of your messages. Editing drops everything after that message and runs again.
- Typing while the agent works queues the message, it shows above the composer and goes out when the reply finishes. A stopped or failed reply holds the queue so you can look first. The queue lives in the window, not on disk.
- Rename (F2), archive and delete (with a confirm) from the menu on each chat. Archived chats sit behind an "Archived" button at the bottom of the list. Sending in an archived chat brings it back.
- Search looks in titles and message text.
- Sessions: Claude keeps a session per thread now (no more `--no-session-persistence`) and later messages resume it with only the new message. Retry and edit clear it since the history changed. If resuming fails it starts over with the full prompt. Other clis still get the full chat every time.
- Attachments come from the brand's media library. The paperclip opens the Media picker with only the files agents may use. Dropped or pasted files get added to Media first, then attached from there, so a file with its agent switch off in Media gets left out with a note. Something pasted that isn't a file on disk, like a copied image, gets a note to save it first.
- The agent gets the name, type, size and media id of each one. It still can't open them, but it can put one on a page with `upload_file`, which only takes files agents may use.
- `attachToChat()` from `chat/attachments.ts` still works for anything that wants to hand files over.
- Shortcuts: Ctrl+Shift+N new chat (Ctrl+N felt too likely to clash later), Ctrl+L type, Esc stop, Alt+Up/Down next or previous chat. They're listed under the chat list.

## Approvals

- Two new cards: `post` and `login`. They show Approve and Decline and nothing happens until you pick. The pick is saved on the reply and is final.
- Approving a post copies it and opens the site tab so you can paste it. Approving a login opens the tab. The app still never posts by itself.
- The agent sees the pick in the history next time ("The user approved a request card").

## Question cards

- The agent can ask with `{"type":"question","question":"...","multi":false,"options":[{"label":"...","description":"..."}]}`. Options get cut to 4, plain strings work too. The card always adds Other with a text box, so an agent's own "Other" option gets dropped.
- Single choice: a click is the answer. Multi choice and Other need Next or Send.
- Several question blocks in one reply show as one card with steps and dots, the answers go out together when the last one is done. They render under the reply text, not where the blocks were.
- The answer goes out as a normal message from you, `Q: question` and `A: pick` lines, so every agent reads it the same way and it shows up in history like anything else. The card reads that message back to show what was picked. Nothing new gets saved on the reply.
- Only the newest reply's questions can be answered, and only once it's done and nothing is running. If you type something else instead, the card shows no answer.
- Sending the answer is a message you sent, so the agent only runs because you clicked.

## Esc

- Esc closes whatever is open first: a modal, a dropdown or menu, the usage popover, the chat list in the side pane, a delete confirm, a search. Only when nothing is open does it stop a reply. It checks what's open at the start of the key press, since a modal closes itself on the same key and would already be gone.

## Home view

- Before the first message the chat shows the brand's name, a short line and four prompt cards (video ideas from today's trends, outline an idea, titles and thumbnail text, posts for every platform). The composer sits right under them with the agent and model pickers, so you can pick both before sending.
- The cards send their prompt straight away. The title shows the full prompt on hover.
- The outline prompt tells the agent it can ask which idea, which shows off question cards.

## Long chats and narrow windows

- Old replies only redraw when that message changes, not on every streamed word of the new one.
- Messages and chats off screen use `content-visibility: auto`, so the browser skips them until they scroll in. Tried with 80 messages and it scrolls fine, so no list virtualizing library for now.
- The chat sizes itself off its own width (container queries), not the window, since the side pane and sidebar change how much room it gets. Under 860 px the chat list gets narrower and drops times, under 620 px the shortcut hints go.
- The search box's native clear button is hidden, Esc clears it instead.
