# Decisions: the content map

Past videos per brand with their numbers, the channel's own baseline, pillars, snapshots after each
upload and post-mortems. Code in `src/main/content-map/`, the cards in
`src/renderer/src/chat/cards/ContentMapCards.tsx`, Settings in `src/renderer/src/components/content-map/`.

## Sources

- YouTube with the creator's own Google OAuth client (Desktop app type), loopback redirect on
  `127.0.0.1` with PKCE, scopes `youtube.readonly` and `yt-analytics.readonly`. Tokens and the client
  secret are sealed with safeStorage in `content-map/`; without OS encryption they aren't kept. They
  never go to the window or an agent and are registered with the gateway's redaction.
- Without a sign-in: the channel's uploads through the Data API with the API key from Settings,
  Trends, else the public RSS feed (15 newest, views and likes).
- The logged-in readers in `main/analytics` for TikTok and Instagram (and YouTube when nothing better
  is set up).
- The project folders: `scripts/script.md`, the newest `.srt`/`.vtt` (export captions match the final
  cut), the newest transcribed take, exports, `thumbnail.txt`. A project with a script or export that
  isn't matched to a post shows as "not posted".
- Captions aren't downloaded from YouTube: `captions.download` needs `youtube.force-ssl`, which can
  change the channel. The hook comes from the project's captions, take or script instead.
- Impressions and CTR aren't in the targeted Analytics API and the Reporting API's reach reports are
  bulk daily jobs. For now they come from a YouTube Studio Content export the creator imports.

## Baseline and what worked

- A video's ratio is views (engaged views for Shorts when known) over the median of up to 10 earlier
  videos of the same platform and format that are at least 7 days old. With fewer than 3 earlier ones
  the format's other settled videos stand in, never the video itself.
- 1.5x and up is "well above usual", 0.6x and below "well below". Under 7 days is "first week" and
  isn't judged or used in what_worked.
- Pillars are labels with keywords. The agent proposes them with `pillar_propose` (always asks); a
  video goes to the pillar whose keywords its title hits most (title counts double).
- Hook and title styles are plain rule-based labels so the groups are explainable.

## Snapshots and post-mortems

- +1h, +6h, +24h, +48h, +7d, +28d after publish. A tick every 5 minutes (first one 20 s after start)
  syncs a catalog older than a day, then takes the latest due snapshot per video if it's within half
  its age (at least an hour) of its time; earlier ones it can't go back for are marked missed.
- videos.list in batches of 50, 1 unit each, inside a self-imposed 6,000 units a day (Pacific day).
  Quota errors wait for midnight Pacific, network errors back off 15 minutes doubling to 6 hours, a lost
  sign-in waits a day.
- After the 48h and 7d snapshots a post-mortem card goes to the newest chat linked to the video's
  project, else the brand's newest chat. If the brand has no chat it's made on a later tick. It
  compares views with earlier videos at the same age, retention at 30 s with the usual, and lists dips
  with the script line said there. Dips at the same relative point in two other recent videos are
  marked recurring. Learnings are only written to `brand/learnings.md` (and committed) when kept.

## Not done

- Reporting API reach reports (impressions and CTR without a CSV).
- Post-publish snapshots for TikTok and Instagram; their numbers come from the existing readers only.
- Dip markers on the FilmCraft timeline.
