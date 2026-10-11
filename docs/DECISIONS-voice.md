# Decisions: brand voice

Calls made while building the Brand voice page.

## Storage

- Voice data is one json per brand in `voice/` in the user data folder, not inside `trenddeck.json`. A post library can get big and the main file is rewritten on every small change.
- Deleting a brand deletes its voice file in the same place logins and trends get wiped. A save that shows up after that is ignored so the file can't come back.
- The page saves 400 ms after the last change and again when you leave it.
- Caps: 2000 posts per brand, 5000 characters per post, 60 posts per site per import.

## Profile

- Free text for who the brand is, audience and things it never says. Chips for tone, topics, words, emoji, calls to action, links and hashtags.
- Calls to action and links are added one per enter since they can have commas in them.
- Per site handles live in the profile because the importer needs them. Notes per site only go to the agent when writing for that site, or all of them when no site is picked.

## Past posts

- Paste one post, or a few split by a line of `---`.
- Files: txt splits on blank lines (or `---`). csv and json look for a text column by common names (text, caption, body, full_text, title...), plus optional site, date, views, likes and url. An X archive `tweets.js` works as is. The site picked next to the box is used when the file has none.
- Same post twice is skipped: same url, or same site and text. Importing again refreshes views and likes on posts you already have.
- Stars, tags and delete are per post. Sorting by best uses views, or likes when there are no views, ranked within the post's own site.

## Import from my accounts

- Only runs when you press Import. It opens a hidden window on the brand's own session for each site, loads your profile page, scrolls a few times and reads what the page shows. Nothing is sent anywhere.
- Pages read: YouTube `/@handle/videos` and `/shorts`, TikTok `/@handle`, Instagram `/handle/`, X `/handle`, Reddit `/user/name/submitted/`.
- X and Reddit can find your handle from the login. YouTube, TikTok and Instagram need it typed in the profile, there's no reliable page that says who you are.
- What each site gives: YouTube titles, views and a rough date from "3 days ago". TikTok captions from the thumbnail text, views, and the date from the video id. Instagram captions only, from the grid's image text, and posts where Instagram made up the text are skipped. X text, date, likes and views, reposts are skipped. Reddit title, body, date and score as likes.
- If the page lands on a login screen it says so instead of guessing.
- These read the page markup, so they'll break when a site changes it. The scripts are in `src/main/voice/importers.ts`, one per site.
- Testing: set `TRENDDECK_VOICE_SAMPLES` to `src/main/voice/samples` and the importer reads those saved pages instead of the real sites. They copy the parts of each site's markup the scripts look at.

## Summary

- Counted locally, no agent: posts, average words, characters and lines, emoji and hashtags per post, how many ask a question or have a link, common first three words, common endings, top emoji, hashtags and words, and best performers (top quarter within their site).
- Openers, endings and words only show when they repeat once there are 6 or more posts, so one-offs don't look like habits.
- The summary is a text box. Once you edit it, your text is used and it stops updating. Reset puts the counted one back.

## Context pack

- `getBrandContext(brandId, platform?, budgetChars?, parts?)` in `src/main/voice/index.ts` is what the chat should call. It returns the text and its sizes. It uses `buildContext` in `src/shared/voice.ts`, the same function the preview uses, so the preview is exactly what the agent gets.
- Order: a one line header, the profile, the summary, then example posts until the size limit.
- When example posts are on, the profile gets at most 40% of the limit and the summary 30%, so a long profile can't push every real post out.
- Example posts are ranked by starred first, then same site as the one you're writing for, then how well they did, then how recent. Each one is cut at 800 characters.
- The size limit is in characters, 6000 by default, with a rough token count next to it (characters / 4).
- Switches for profile, summary and examples are saved per brand and used by default.

## Learn my voice

- It never calls an agent. It puts a message in the chat box with a short ask plus the context pack, and opens the chat if it's closed. You send it or not.
- The draft gets to the chat box through `pages/voice/chatDraft.ts`. The chat takes it on open or when one comes in, the `onDraft` line in `chat/ChatView.tsx`.

## Not done

- No automatic re-import or schedule, on purpose.
- Instagram likes and views aren't on the grid page, so they're empty.
- The chat doesn't call `getBrandContext` yet, that's for the chat branch to wire in.
