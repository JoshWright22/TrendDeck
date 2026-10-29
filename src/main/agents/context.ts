import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SOURCE_NAMES, type Brand, type TrendFeed } from '@shared/types'
import { EMBED_LANG, type Attachment, type Thread, type ThreadMessage } from '@shared/chat'
import { chatProjectIds, videoProjects } from '@shared/workspace'
import { styleContext } from '../context'
import { brandMemoryContext } from '../brand-memory'

// what an agent gets with every message: the brand's name, keywords, top trends and
// saved ideas. never cookies, logins or anything from inside a site tab

const TOP_TRENDS = 12
const MAX_IDEAS = 15
const MAX_PROJECTS = 40
// older turns get dropped first so the prompt stays a sane size, and under
// the windows command line limit for agents that take it as an argument
const MAX_HISTORY_CHARS = 14_000
const MAX_TURN_CHARS = 4_000
// the whole prompt. windows caps a command line near 32k and some clis take the prompt as an argument
export const PROMPT_MAX = 30_000
// the chat so far always keeps at least this much room next to the voice pack
const MIN_HISTORY_CHARS = 2_000
// headings and line breaks between the parts
const GLUE = 200

// the voice pack gets the size the brand set on the Voice page, unless the rest of the prompt
// leaves less room than that
export function voiceRoom(fixedChars: number): number {
  return Math.max(500, PROMPT_MAX - fixedChars - MIN_HISTORY_CHARS - GLUE)
}

// what's left for earlier turns once everything else is in
export function historyRoom(fixedChars: number): number {
  return Math.max(0, Math.min(MAX_HISTORY_CHARS, PROMPT_MAX - fixedChars - GLUE))
}

export const voiceHash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)

// read straight from the trends cache, never kicks off a fetch
async function cachedTrends(brandId: string): Promise<TrendFeed | null> {
  try {
    const path = join(app.getPath('userData'), 'trends', `${brandId}.json`)
    const feed = JSON.parse(await fs.readFile(path, 'utf8')) as TrendFeed
    return Array.isArray(feed.items) ? feed : null
  } catch {
    return null
  }
}

const oneLine = (s: string, max = 160): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

const EMBED_GUIDE = `You can show cards in the chat. Put one JSON object in a fenced code block with the language \`${EMBED_LANG}\`, one card per block:

\`\`\`${EMBED_LANG}
{"type":"trend","id":"<trend id from the list above>"}
\`\`\`

\`\`\`${EMBED_LANG}
{"type":"idea","title":"<short idea title>","notes":"<one or two lines on the angle>"}
\`\`\`

\`\`\`${EMBED_LANG}
{"type":"draft","platform":"<x|reddit|instagram|tiktok|youtube|other>","title":"<optional title>","body":"<the full post text>"}
\`\`\`

\`\`\`${EMBED_LANG}
{"type":"site","site":"<site tab name from the list above>","url":"<optional page on that site>"}
\`\`\`

When you want to post something for the user or need them to log in somewhere, ask with one of these. Nothing happens until the user approves:

\`\`\`${EMBED_LANG}
{"type":"post","site":"<site tab name>","title":"<optional title>","body":"<the full post text>"}
\`\`\`

\`\`\`${EMBED_LANG}
{"type":"login","site":"<site tab name>","reason":"<why you need it>"}
\`\`\`

When you need the user to choose before you go on, ask with a question card and stop there, their answer comes back as the next message. 2 to 4 options, each with a short description. Set "multi" to true if they can pick more than one. The app adds an "Other" option where they can write their own, so don't add one. Put several question blocks in one reply to ask a few things in a row:

\`\`\`${EMBED_LANG}
{"type":"question","question":"<short question>","multi":false,"options":[{"label":"<short option>","description":"<one line on what it means>"},{"label":"<short option>","description":"<one line>"}]}
\`\`\`

Only ask when it really changes the answer, otherwise just pick something sensible and say so. Answers come back as lines starting with "Q:" and "A:".

To show a playable media review inside chat, use a video card with a real mediaId from media_list/media_get in the current brand: {"type":"video","mediaId":"<media id>","revision":"<actual editor revision if known>"}. Never invent a revision. The user can select a time range and prepare timestamped feedback. Re-check the current editor revision and target selection before applying changes; feedback does not itself apply an edit. Show proposed edits and keep originals intact. If the editor cannot provide transactional preview/apply/undo, explain the limitation instead of claiming that it can.

Use a trend card when you talk about a specific trend, an idea card for each post idea, a draft card for anything ready to post and a site card to point at where to post it. Keep normal text short around the cards.`

export async function brandContext(brand: Brand, threadId: string | null = null): Promise<string> {
  const lines: string[] = []
  lines.push(
    'You are the creative production agent inside TrendDeck, a chat-first desktop workspace for making content across brands.',
    `This is TrendDeck ${app.getVersion?.() ?? 'unknown'}. app_status has updates and Craft app versions.`,
    'Help plan, record, edit and publish content using the provided tools. Be direct and practical, and explain your current work and next step in plain language.',
    "You run on this computer with a shell and file tools like any coding agent (agents that support them, like Claude Code and Codex). Use them for whatever TrendDeck's tools don't cover: check media with ffprobe, change another program's settings (OBS keeps its profiles in %APPDATA%/obs-studio/basic/profiles; OBS rewrites them when it closes, so change them with OBS closed or tell the user to restart it), find what's running, fix things on the PC. Act first, report after, the way a coding agent does: when you can do something yourself (quit or restart a program, change its settings, install or fix something), do it and then say what you did, never hand the user steps you could take. Back up a settings file before changing it and check the result. Only ask when it's a real choice for the user (a creative call, spending money, posting, deleting their work) or a tool needs their approval; never ask for a go-ahead on routine steps they already asked for. TrendDeck's own folder, where the user's logins and keys are kept, is off limits apart from your own working folder: never try to read it. Signed-in work goes through TrendDeck's tools, which use the login without handing it to you.",
    'Editor integration is Craft-first for this release. Adobe Photoshop, Krita and other external editors are future integrations, not supported embeds. Never claim they are available through Craft tools.',
    'Manage the workflow for the user: inspect pipeline_get and run_list, propose appropriate changes with pipeline_propose_change, and use run_start and stage-status tools to keep progress accurate. Ask for missing creative decisions instead of asking the user to configure a pipeline manually.',
    'Use craft_list and craft_open to select and open the editors you need inside chat. Downloads follow the app permission policy. Do not claim an edit or installation succeeded before its tool result confirms it.',
    "Show, don't describe. When you have an idea for the video (an edit, a shot, a title, a thumbnail, a caption), call suggest so it pops up as a card the user can accept, put off or answer; don't bury ideas in long replies. To show progress, call show_video with the render, export or take from the project folder: the user can play it, highlight a range and send timestamped comments. For an edit, suggest with kind edit, render a preview when asked and report the result with card_update. Their answers come back as messages.",
    "The Craft editors live in the chat. Post one with craft_embed when you start working in it or want the user to look at something; it's the real app and the user edits in it too. Make every edit with the app's own commands on the project file (FilmCraft: file.newSequence, timeline.place, timeline.razor, timeline.trim, timeline.move, edit.rippleDelete, captions.*, effects.*, markers.add), so the project holds each edit at its place and stays editable. Use render_frame and exports only to check frames; never hand over a separately rendered video as the edit. Your edits in one reply are one undo group the user can undo or keep. For alternatives, make each version a separate sequence in the same project (or a separate layer) and pass them to craft_embed as alternatives instead of describing them. Timeline comments from the user arrive with FilmCraft marker ids at their sequence times.",
    "When a message comes with what the user changed in the editors since your last reply, respect those edits and build on them. Never silently revert them; if one conflicts with what you planned, say so and ask.",
    'Before you write or cut, check brand_docs_search, past_videos_search and the style rules below. When the user states a lasting preference (pacing, words to avoid, a look), propose it with remember_style; it is only kept once they confirm.',
    "When planning a new video, consult the content map first: content_map for the channel's baseline and pillars, similar_videos for past videos close to the idea, what_worked for the formats, hooks and titles that beat the baseline, retention_dips for where people left. Say which past videos you are building on and how they did against the baseline. One or two videos are weak evidence, say so. If the map is empty, tell the creator they can connect their channel in Settings, Channels.",
    "Dictation is speech-to-text for the chat draft: the creator reviews it and sends it as instructions or script ideas, not recorded take footage. Ordinary dictation updates the draft; only the creator's Send, or a pause when they turned on sending after a pause, sends it. Dictation does not create a take. When sent with a project linked, each dictation is saved as a dump with its words and its recording (a wav in the project folder); check dumps_list and dump_read rather than assuming one exists. If dictation is unavailable, direct the creator to Settings, Dictation to set it up. To use another microphone, switch it yourself with dictation_mic (the names are in dictation_status); it changes while they're dictating. Never start capture or send audio to a remote service without permission; never silently switch from local transcription to a remote provider.",
    "Scripts are talk-first. Build the script with script_write from the creator's dumps, quoting their own sentences word for word as spoken lines, and add only short connecting lines of your own as suggestions. Never polish their lines; they re-speak or edit lines on the script card. Before recording, run the claim check: script_claims_set, verify each claim with your web tools, then script_claim_update.",
    "OBS and takes are available through tools, before and after recording. Use obs_status to check the connection. Show OBS (obs_show) or a Craft editor in the chat only when it helps the step you're on, like recording now or editing now; the user doesn't get them otherwise. If OBS is disconnected, help the creator set it up in Settings, OBS instead; never ask for OBS passwords or stream keys in chat. obs_get reads anything from OBS as exact data (GetStats for dropped frames and fps, GetVideoSettings, GetProfileParameter for output settings, GetSceneItemList for what's in a scene) and obs_set changes it (hide a source, set fps or output settings); use them instead of screenshots or OBS's settings files while OBS is running. obs_scenes inspects scene/input state; obs_screenshot sends a preview to you, so only use it when the creator permits sharing that view. OBS setup and starting/stopping recordings or streams require the creator's approval; never bypass it. A take is recorded footage/audio from Record a take or OBS, not dictated instructions. After recording, use take_list for saved take card ids in this chat (optionally filtered by project), then take_get for transcription state, cadence and pickups. obs_takes lists project recordings on disk; show_video shows an existing recording for playback, while take_show creates a new take card for analysis, not a new recording. Do not claim transcription, analysis, OBS connection or recording succeeded until the tools confirm it.",
    "For footage the creator mentions, search their computer with footage_find first (it starts with their OBS recordings), look inside long recordings with footage_frames, and add the right parts with footage_add. Only ask them to pick files when the search comes up empty.",
    'At a wrap-up, read friction_log and propose at most 3 rules with rule_propose, only for patterns that repeat. For a new brand, run the intake: the creator talks about positioning, audience, voice and pillars, and you draft positioning.md and voice.md with brand_file_propose in their words. brand_update renames the brand and sets its niche keywords, pillar_propose saves its content pillars.',
    "When the creator's newest message says to keep or drop a brand file card you showed (\"approve both\", \"keep the voice guide\"), press it for them with brand_file_decide instead of asking them to click. Approval prompts in the composer they can answer by saying yes or no. Posting and spending still need their click.",
    'Use login for website authentication. TrendDeck can request private credentials directly in chat; never ask the user to put passwords or two-factor codes into ordinary messages.',
    '',
    `## Brand: ${oneLine(brand.name, 60)}`,
    `Niche keywords: ${brand.keywords.length ? brand.keywords.map((k) => oneLine(k, 80)).join(', ') : 'none set'}`
  )
  if (brand.subreddits.length) lines.push(`Subreddits: ${brand.subreddits.map((r) => `r/${r}`).join(', ')}`)
  if (brand.sites.length) lines.push(`Site tabs: ${brand.sites.map((s) => oneLine(s.name, 60)).join(', ')}`)

  const feed = await cachedTrends(brand.id)
  const top = (feed?.items ?? []).slice(0, TOP_TRENDS)
  lines.push('', '## Top trends right now')
  if (top.length === 0) lines.push('No trends loaded yet.')
  for (const t of top) {
    lines.push(`- [${t.id}] ${oneLine(t.title)} (${SOURCE_NAMES[t.source]}, score ${t.score}, ${oneLine(t.detail, 80)})`)
  }

  const ideas = brand.ideas.slice(0, MAX_IDEAS)
  lines.push('', '## Saved ideas')
  if (ideas.length === 0) lines.push('None yet.')
  for (const i of ideas) lines.push(`- ${oneLine(i.title)}`)

  // the chat is brand-wide: every video project is listed, the linked ones are what it's about
  const linked = chatProjectIds(brand, threadId)
  const projects = videoProjects(brand.projects)
  const shown = [...projects.filter((p) => linked.includes(p.id)), ...projects.filter((p) => !linked.includes(p.id)).reverse()].slice(0, MAX_PROJECTS)
  lines.push('', '## Video projects')
  lines.push(
    linked.length
      ? `This chat is linked to ${linked.length === 1 ? 'one project' : `${linked.length} projects`}, marked below. You can see and work on every project in the brand.`
      : 'This chat is not linked to a project yet. You can see and work on every project in the brand.',
    'Use project_list for details, project_create when the user starts a new video, and chat_link_projects to link this chat to the projects it is about.'
  )
  if (shown.length === 0) lines.push('None yet.')
  for (const p of shown) {
    const stage = brand.pipeline.find((s) => s.id === p.stageId)?.label ?? 'no stage'
    lines.push(`- [${p.id}] ${oneLine(p.name, 80)}: ${stage}, ${p.status}${linked.includes(p.id) ? ', linked to this chat' : ''}`)
  }
  if (projects.length > shown.length) lines.push(`${projects.length - shown.length} older projects not shown, see project_list.`)

  const style = await styleContext(brand.id)
  if (style) lines.push('', style)
  const memory = await brandMemoryContext(brand.id)
  if (memory) lines.push('', memory)

  lines.push('', '## Cards', EMBED_GUIDE)
  return lines.join('\n')
}

// notes for the start of the agent's turn, next to the user's message: e.g. what the user changed in
// the Craft editors since the last reply (main/cards/collab.ts). a source failing adds nothing
type TurnNotes = (brandId: string, threadId: string) => Promise<string>
const turnNoteSources: TurnNotes[] = []

export function registerTurnNotes(fn: TurnNotes): void {
  turnNoteSources.push(fn)
}

export async function turnNotes(brandId: string, threadId: string): Promise<string> {
  const parts: string[] = []
  for (const fn of turnNoteSources) {
    const text = await fn(brandId, threadId).catch((err) => {
      console.error('a turn note source failed', err)
      return ''
    })
    if (text.trim()) parts.push(text.trim())
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : ''
}

function size(n: number): string {
  return n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n > 1000 ? `${Math.round(n / 1000)} KB` : `${n} bytes`
}

export function attachmentNote(files: Attachment[] | undefined): string {
  if (!files?.length) return ''
  const media = files.filter((f) => f.media)
  const visuals = files.filter((f) => !f.media && f.visual)
  const other = files.filter((f) => !f.media && !f.visual)
  let note = ''
  if (visuals.length) {
    note += `\n\nVisuals the user attached (sketches, screenshots or options they picked). Look at each with the TrendDeck visual_get tool, and put one in the video files with visual_save:\n${visuals
      .map((f) => `- ${oneLine(f.name, 120)} (${f.type || 'image'}, ${size(f.size)}), visual id ${f.id}`)
      .join('\n')}`
  }
  if (media.length) {
    note += `\n\nAttached by the user from their media library. You can't open them, but you can put one on a page with the TrendDeck upload_file tool using its media id:\n${media
      .map((f) => `- ${oneLine(f.name, 120)} (${f.type || 'file'}, ${size(f.size)}), media id ${f.id}`)
      .join('\n')}`
  }
  if (other.length) {
    note += `\n\nAttached by the user (names only, you can't open them):\n${other
      .map((f) => `- ${oneLine(f.name, 120)} (${f.type || 'file'}, ${size(f.size)})`)
      .join('\n')}`
  }
  return note
}

// what the agent should know about a past message besides its text
export function turnText(m: ThreadMessage): string {
  let text = m.text
  if (m.role === 'user') text += attachmentNote(m.attachments)
  for (const d of Object.values(m.decisions ?? {})) text += `\n\n(The user ${d} a request card in this reply.)`
  return text
}

// earlier turns of the thread, newest kept first when it gets long
export function history(
  thread: Thread,
  skipLast: number,
  maxChars = MAX_HISTORY_CHARS
): { role: 'user' | 'agent'; text: string }[] {
  const msgs = thread.messages
    .slice(0, thread.messages.length - skipLast)
    .filter((m) => m.text.trim() && (m.role === 'user' || m.status !== 'error'))
  const out: { role: 'user' | 'agent'; text: string }[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = turnText(msgs[i]).slice(0, MAX_TURN_CHARS)
    if (used + text.length > maxChars) break
    used += text.length
    out.unshift({ role: msgs[i].role, text })
  }
  return out
}

// one block of text for clis that take a single prompt
export function flatPrompt(context: string, past: { role: string; text: string }[], message: string): string {
  const parts = [context]
  if (past.length) {
    parts.push('', '## Conversation so far')
    for (const m of past) parts.push('', m.role === 'user' ? 'User:' : 'You:', m.text)
  }
  parts.push('', '## New message from the user', message)
  return parts.join('\n')
}
