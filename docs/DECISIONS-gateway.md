# Decisions: agent tool gateway and pipeline

The agent runs the brand through tools. It never sees a key, password, cookie or token: main holds
those and does the signed-in work, the agent gets ids and results.

## One door

- Every tool is a `GatewayTool` in `src/main/gateway` (data tools), `src/main/mcp/tools.ts` (brand and
  site tabs) or `src/main/pipeline/tools.ts`. Each has a name, title, description, JSON schema, a risk
  level and MCP annotations (read only, destructive, idempotent, open world; defaults come from the risk).
- `callGatewayTool` in `gateway/call.ts` is the only way in, the MCP server's `tools/call` goes there.
  Order: known tool, strict args, policy, approval, run, redact, audit.
- Args are checked against the schema with no coercion. Unknown args are refused with the accepted
  names, so the agent can fix the call itself. Nulls count as left out.

## Risk and approval

- `read` looks, `edit` changes brand data inside TrendDeck, `publish` puts something on a site or a
  phone, `spend` costs money or quota (nothing uses it yet).
- Defaults per brand: read and edit run, publish and spend ask. A per tool rule (`auto`, `ask`, `deny`)
  wins over the risk rule, deny wins over everything. Stored in `gateway/policy.json`, apart from
  `trenddeck.json` so the ui saving brand data can't change it.
- An ask sends `gateway:approval-request` to the app window and the call waits. No answer within the
  brand's timeout (default 5 minutes) is a no. The turn ending cancels it. No window means no.
- The user can approve once or for the rest of the turn (`scope: 'turn'`).
- `pipeline_propose_change` always asks, whatever the policy, and the card gets a diff of the stages.
  Finishing or skipping a stage that isn't `auto` asks too.
- Phone input is `publish`: the phone has no post button guard like the site tabs do.

## Redaction

- Second lock, the tools already don't hand out secrets. Every result, error, audit entry and approval
  card goes through `gateway/redact.ts`.
- Keys named like password, token, cookie, api key, secret and so on are blanked. Booleans stay, so
  `hasPassword: true` still reads right.
- Text is scrubbed for auth and cookie headers, bearer tokens, JWTs, common key shapes (OpenAI and
  Anthropic, AWS, GitHub, Slack, Google, Meta), secrets in url queries, `password=` style pairs and
  hex of 40 or more characters (turn tokens). UUIDs stay.
- The exact values main knows are scrubbed anywhere: saved login passwords and note lines, posting API
  keys, analytics tokens, the YouTube key and every live turn token. Cached 30 seconds per brand.

## Audit

- Append only JSONL per brand, `gateway/audit/<brand>.jsonl`, moved to `.old.jsonl` past 4 MB.
- Each line: time, thread, turn, tool, risk, args (redacted, long text cut to 300), decision (auto,
  approved, denied, timeout, cancelled, blocked, invalid), ok, a short redacted result and how long it took.
- `beginAgentTurn(brandId, agent, { threadId })` puts the chat thread on the turn for the log.

## Data the ui also holds

- Ideas and the schedule live in `trenddeck.json`, which the ui saves whole. Agents change them in main
  and main sends `gateway:data-changed` with kind `app`, the ui loads the data again before it saves.
  Writer, media, inbox, posting and trends send their own kind so an open page reloads.

## Pipeline

- `pipeline/<brand>.json` holds the stages and the runs. Defaults when a brand has none.
- A run has a state per stage (pending, running, waiting_user, done, skipped, notes, artifact ids) and a
  current stage. Advancing finishes the current stage and starts the next unfinished one. When stages
  change, runs keep the states of removed stages and move to a stage that still exists.
- `ask_user` uses the chat's question card shape (question, options with label and description, multi)
  plus an Other box, waits up to 15 minutes and returns the picks and the same `Q: / A:` text the chat
  card sends.
- Pure rules are in `pipeline/model.ts`, tested with `npm run test:gateway` with redaction, validation
  and policy.
