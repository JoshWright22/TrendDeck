# Decisions: talking, scripts, takes and brand memory

Calls made while building the speak, structure, record, diff, learn loop for the first video. The research behind it is in `reports/Video editing agent harnesses.md` (not in git).

## Dictation in the composer

- The mic is an icon in the composer toolbar next to attach. Click starts and stops, holding the shortcut (Ctrl+Space by default, Settings, Dictation) talks while held. Its small menu has hands-free, the dictation sources you set up (downloaded local models and configured providers) and Settings.
- The mic is cut into utterances at pauses (`src/shared/vad.ts`, about 1.1 s of quiet, 25 s at most) and each one is transcribed while you keep talking. Finished words go straight into the text box as normal text you can edit. The part still being transcribed shows in a lighter gray behind the text box until it's final. There is no review step.
- Hands-free keeps listening across sends and shows "Listening" in the toolbar. While a reply runs, what you say goes straight in as a steer. Auto-send after a pause is off by default.
- Privacy and endpoint details live only in Settings, Dictation.
- Every dictated message is kept with its word times: as a dump in the project (`scripts\dumps\<id>.json`) when the chat has a project, otherwise only in the brand's cadence profile. The message tells the agent the dump id.

## Talk-first scripts

- "Talk through a video" on the chat home starts the mic with a script ask in front of what you say. The agent builds the script with `script_write`: beats from your own sentences marked spoken, short connecting lines of its own marked as suggestions.
- Main checks every line the agent marks spoken against the dumps (`findQuote` in `src/shared/script.ts`): the words in order with at most one word in ten different; case, punctuation and filler words don't count. Anything looser is saved as a suggestion and listed back to the agent. A line you said or typed stays yours across rewrites (same words keep the same id).
- The script is `scripts\script.md` in the project folder: one list item per line tagged `[you]`, `[suggestion]` or `[typed]`, with the line id in an HTML comment, so it reads fine on its own and git keeps its history. Claims sit next to it in `script.claims.json`.
- On the script card each line shows who it's from (your lines bright, suggestions gray and italic, never color), its cadence notes and claims, and Say it again, Edit, Remove, Ask agent. Saying a line again records until a pause and replaces the text; the recording is saved as a dump too.

## Cadence

- `src/shared/cadence.ts` measures pace (long thinking pauses count as one breath), sentence length, pauses, filler words, contractions, how often you say "you" and repeated phrases. Every dictation and take adds to `brand\cadence.json` in the brand folder.
- Drafts get notes, not a score: sentences much longer than you speak, words that read written ("moreover", "delve"), stiff full forms when you use contractions, semicolons and brackets, and words you never use when talking (once there are 500 spoken words). Your own lines only get the length note. Read time uses your own pace, 150 words a minute before there is a profile.

## Claim check

- "Check claims" on the script card asks the agent to act as a separate fact checker: list every claim with `script_claims_set`, verify each with its web tools, report each with `script_claim_update`. Sourced needs a url.
- Ready to record is blocked while a number or quote has no source or any claim is marked wrong. Facts that couldn't be verified only get a note.

## Takes

- The record icon in the toolbar records mic or camera and mic. With a project the take goes to `footage\takes\` and becomes a take card; without one it goes to Media and gets attached, as before.
- OBS recordings TrendDeck started become take cards on stop through `ingestRecording` in `src/main/takes/ingest.ts`.
- Main pulls the audio out with the bundled ffmpeg (16 kHz mono float). The window transcribes it with the same dictation source as the mic, because local Whisper runs in the window's worker. Then main adds the cadence feedback and compares it with the project's script.
- The diff (`src/shared/take-diff.ts`) aligns the script's words to the take's words (longest common subsequence, filler words left out). A line is said, said differently (under 85% of its words or a lot of extra words), flubbed (a restart like "the first, the first") or missed (under a third of its words). The pickup list is the missed and flubbed lines plus lines said very differently, with the time it went wrong.
- What you said instead of a script line goes in the friction log, it's the best evidence of how you talk.

## Brand memory

- The friction log is JSONL per brand in `<user data>\brand-memory\<brand>\friction.jsonl`: turned down and undone suggestions, re-spoken lines, edits and removals of the agent's lines, take paraphrases, dropped and edited rules.
- After three or more logged changes the composer offers Wrap up. It starts a new session and sends the agent the log. The agent proposes rules with `rule_propose`, at most three per session (refused in main after that), each pointing at the log entries it comes from.
- A kept rule goes into the existing style rules (`main/context`, so it reaches the agent every turn) and into the brand folder, `Documents\TrendDeck\<brand>\brand\`: voice rules under "Rules learned from your edits" in `voice.md`, the rest in `rules.md`, each with the date, card and the changes it came from, plus a line in `learnings.md`. The folder is a metadata-only git repository and each kept rule or file is a commit.
- Every turn gets positioning.md and voice.md (cut to 3000 characters together with the cadence summary) after the style rules.
- `onDigestDue` in `main/brand-memory` is the hook for a weekly digest card. It checks once a day; nothing registers for it yet.

## Brand intake

- A brand without a voice guide gets "Set up this brand by talking" on the chat home. You talk about who it is for, the promise, how you talk, what you are not and your pillars; the agent drafts `positioning.md` and `voice.md` with `brand_file_propose` in your words. Each is a card with Keep, Edit and Drop, nothing is written before Keep.
