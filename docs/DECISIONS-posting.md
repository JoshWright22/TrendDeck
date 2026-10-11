# Posting decisions

Calls made while building posting, so nobody has to guess later.

## How a post goes out

- Posting is its own page in the sidebar with three tabs: Queue, Log and Setup.
- One post goes to one site. Picking three sites in New post makes three cards in the queue, so each one can fail or get fixed on its own.
- Default is the logged in tab. The app opens a separate window on the brand's own session, so it has the same logins as the site tabs but doesn't take over the tab you have open. Login popups in that window work like they do in a site tab and stay on the same session.
- The window fills everything in and stops at the final Post button with a teal ring round it. You press Post. The app watches the page and marks the card Posted when the site says it went out.
- Closing the window before that marks it "Not sent". If you posted and the app missed it, press "It went out" on the card.
- "Press Post for me" is per brand and off by default. With it on the app presses Post and waits up to 3 minutes to see it go out.
- When a step breaks the window stays open so you can finish by hand or see what changed on the site. The card and the log say which step broke.
- Only one post runs at a time, the rest wait in line.

## Adapters

- One small file per site in `src/main/posting/adapters/`, just a list of steps and selectors. When a site changes that file is the only thing to fix.
- Each step has a list of selectors tried in order. Besides plain css there's `text=Next` for a button by its text, `a >>> b` to go into a shadow root and `deep:` to search every shadow root. Reddit needs the last two.
- Typing selects whatever is in the field and types over it with real key input, not by setting the value, so React and the other editors see it. YouTube and TikTok put the file name in the title or caption first, this replaces it.
- Files go in through the devtools protocol since a page can't set a file input from js.
- Instagram videos go up as reels, that's what the web create dialog does now.
- YouTube is always marked not made for kids. TikTok and YouTube get public, unlisted or private from the post.
- Reddit flair isn't set. Subs that need it will stop at the Post button with an error on the page, you pick it there.

## Self-check

- Setup has a Self-check button per site. It opens the brand's session, walks the steps and reports ok, broke or skipped for each one, then closes.
- It never types or presses anything that could post. Steps that open a menu get clicked, fields and buttons are only looked for.
- YouTube, TikTok and Instagram only show the rest of their form after a real file is in, so their check stops at the file input. Their later steps get checked on a real post and the log says which one broke.
- A check that breaks on the first step usually just means you're logged out of that site.

## Scheduling

- Scheduled posts only fire while the app is open. The main process looks every 20 seconds.
- A post that came due while the app was closed fires when it opens if it's less than an hour late. Older than that it's marked Missed so a stale post doesn't go out at a weird time.
- A post that was running or open for review when the app quit comes back as Failed or Not sent.

## Official API mode

- Set per brand and per site in Setup, since each brand is a different account. That's why it's on the Posting page and not in the main Settings window.
- Keys are saved in `posting-keys.json` in the user data folder, encrypted with the OS keychain when it's available. The page only learns which keys are saved, never their values.
- YouTube: Data API resumable upload. Sign in uses a desktop OAuth client you make yourself. The sign in opens in a window on the brand's own session, so a Google account already logged in there is offered right away, and a local loopback page catches the code.
- TikTok: Content Posting API direct post with a pasted user token. Apps TikTok hasn't reviewed can only post private, so it falls back to private when public isn't allowed.
- Instagram: Graph API. Instagram downloads the media itself, so API mode needs a public https link to it on each post. Tokens starting with IG go to graph.instagram.com, the rest to graph.facebook.com.
- X: API v2 with a pasted OAuth 2 user token. Text and one image. Video goes through the tab for now.
- Reddit has no API mode, it was left out on purpose.
- Pasted tokens aren't refreshed. When one expires the post fails with the site's message and you paste a new one.

## Data

- Queue, log and per brand settings live in `posting.json` in the user data folder, not in `trenddeck.json`, so posting doesn't touch the main store.
- The log keeps the last 1000 entries across all brands.
- Deleting a brand drops its queue, log and keys.
- Media is never copied, the post keeps the file path. Moving or deleting the file makes the post fail with a clear message.
