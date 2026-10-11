# Inbox decisions

Calls made while building account health and the inbox, so nobody has to guess later.

## Account health

- Every site of a brand shows a dot in the sidebar: teal is logged in, pink needs login, grey is unknown. The Inbox page has an Accounts tab with the same list and a Check button.
- The check reads the login cookie each site sets from the brand's own session. It never loads a page, so it's quick and can't log you out or trip a bot check.
- It runs when a site tab finishes loading (just that site) and when you press Check (every site of the brand).
- Sites with no known login cookie show unknown. The list is in `src/main/inbox/health.ts`, add a line there for a new site.
- A cookie can outlive a login the site revoked on its end. The dot can say logged in when the site would ask you to sign in again. Opening the tab fixes it.

## Comments

- Refresh opens a hidden window on the brand's session for each of YouTube, Instagram, TikTok, X and Reddit the brand has a tab for, reads the page the site lists your comments on, then closes it. Nothing runs on a timer.
- A site that's logged out is skipped and the page says so.
- One reader per site in `src/main/inbox/readers.ts`: a url and a page script. When a site changes its page that file is the only thing to fix.
- The pages read: YouTube Studio comments, Instagram notifications, TikTok Studio comments, X mentions, old Reddit comment replies. The readers were only tested against saved sample pages, not the live sites, so expect to fix selectors on first real use.
- The account on a comment is the name of the site tab it came from. Two tabs for the same site only read once, from the first tab, since both share the session.
- Comments seen before keep their read mark. Ones not seen on a refresh stay in the list. The inbox keeps the newest 2000 per brand.
- Open in tab hands the link to the app, which opens it in a site tab like any other link.

## Reply

- Reply opens a window on the brand's session at the comment, opens the reply box and types the text in. You press the site's own Reply. It never presses it for you.
- If the reply box isn't found the window stays open so you can paste it in.

## Spam

- Hide commenter hides that person's comments everywhere in the brand's inbox. It's keyed on site and name, so the same name on another site isn't hidden.
- Keyword filters hide comments that contain the word, case doesn't matter.
- Hidden comments are kept, only not shown. The count shows next to the filters and removing the rule brings them back.
- Block on the site opens the commenter's profile in a window on the brand's session. You use the site's own block or report there. The app doesn't click it, those menus change too often and a wrong click is hard to undo.

## Data

- Everything lives in `inbox/<brand>.json` in the user data folder, not in `trenddeck.json`.
- Deleting a brand drops its inbox file.
- Test runs can set `TRENDDECK_INBOX_SAMPLES` to a folder of saved pages (`youtube.html`, `x.html` ...) and Refresh reads those instead of the real sites.
