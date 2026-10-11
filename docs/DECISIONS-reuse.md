# Reuse decisions

Calls made while building Shorts, so nobody has to guess later.

## Short video everywhere

- The video comes from the brand's Media library through the picker, videos only. The page gets a library id, main reads the file's length and size from it and posting turns the id into a path right before it runs.

- Shorts is its own page in the sidebar. It needs a video first and a caption per site, that didn't fit in the normal New post box.
- You pick one video and it goes out as a YouTube Short, an Instagram Reel and a TikTok. Any of the three can be turned off.
- Each site gets its own caption. YouTube also gets a title. "Copy YouTube text to the others" fills the other two from it.
- Queue makes one normal scheduled post per site in the posting queue and one slot per site on the Schedule. Nothing new runs them, the posting queue does it like any other post.
- The posts go out a set number of minutes apart, 30 by default. 0 sends them all at once.
- There's a review step before anything is saved. It shows each site, its time, its caption and any warnings.

## Checks

- Length and frame size are read from the mp4/mov header in main, no ffmpeg. Only the moov box gets read so a big file is still quick. A rotated phone video counts as vertical.
- Other formats only get the size check, and a warning that the length wasn't read.
- Problems block the post: not vertical, too long, too short, too big, title missing or too long, caption too long.
- Warnings just show: not exactly 9:16, under 1080p tall, YouTube over a minute without #Shorts.
- Limits used: YouTube 3 min, Instagram 15 min, TikTok 10 min. File size 256 GB YouTube and 4 GB for the other two. Captions 5000 YouTube and 2200 for the other two. They're in `src/shared/reuse.ts` so one file changes when a site does.

## Import my Shorts

- You paste your channel link once per brand, like youtube.com/@yourname. It's kept in the page's local storage.
- The app loads the channel's /shorts page with the brand's own session, so it sees what the logged in YouTube tab sees. It reads the page data, falling back to /shorts/ links when the data moved.
- Reuse fills the Instagram and TikTok captions from the Short's title and turns YouTube off.
- It doesn't download the video. You still pick the file from Media, posting needs a local file anyway and downloading from YouTube is against its terms.
- The note on each post says which Short it came from.

## Posting pace

- Per site, not per brand: a daily limit and a minimum gap in minutes, edited in Settings under Posting pace. It saves as you type like the rest of Settings.
- Defaults: YouTube 3 a day and 2 hours apart, Instagram 3 and 2 hours, TikTok 4 and 90 min, X 15 and 20 min, Reddit 5 and 1 hour. 0 turns a limit off.
- Limits count per brand, since each brand is its own account.
- Only scheduled posts get held back. When one comes due too soon it moves to the first allowed time plus up to 12 random minutes, and the card note says why. Pressing run on a post yourself skips the limits, you asked for it.
- Posts that are queued, running or open for review count as posted just now, so two can't go out back to back.
- A posted time is the post's last update, which is when it got marked Posted.
- Settings in `reuse-pace.json` in the user data folder.

## Not done yet

- The Quora and custom site adapters, best time to post and @-mentions weren't started.
