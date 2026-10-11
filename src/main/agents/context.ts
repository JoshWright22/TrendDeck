import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SOURCE_NAMES, type Brand, type TrendFeed } from '@shared/types'
import { EMBED_LANG, type Attachment, type Thread, type ThreadMessage } from '@shared/chat'

// what an agent gets with every message: the brand's name, keywords, top trends and
// saved ideas. never cookies, logins or anything from inside a site tab

const TOP_TRENDS = 12
const MAX_IDEAS = 15
// older turns get dropped first so the prompt stays a sane size, and under
// the windows command line limit for agents that take it as an argument
const MAX_HISTORY_CHARS = 14_000
const MAX_TURN_CHARS = 4_000

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

Use a trend card when you talk about a specific trend, an idea card for each post idea, a draft card for anything ready to post and a site card to point at where to post it. Keep normal text short around the cards.`

export async function brandContext(brand: Brand): Promise<string> {
  const lines: string[] = []
  lines.push(
    'You are the assistant inside TrendDeck, a desktop app creators use to find trends and plan posts.',
    'Help with post ideas, hooks, titles, captions and scripts. Be direct and practical, write in markdown.',
    "Don't run commands or edit files, just answer in text.",
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

  lines.push('', '## Cards', EMBED_GUIDE)
  return lines.join('\n')
}

function size(n: number): string {
  return n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n > 1000 ? `${Math.round(n / 1000)} KB` : `${n} bytes`
}

export function attachmentNote(files: Attachment[] | undefined): string {
  if (!files?.length) return ''
  return `\n\nAttached by the user (names only, you can't open them):\n${files
    .map((f) => `- ${oneLine(f.name, 120)} (${f.type || 'file'}, ${size(f.size)})`)
    .join('\n')}`
}

// what the agent should know about a past message besides its text
export function turnText(m: ThreadMessage): string {
  let text = m.text
  if (m.role === 'user') text += attachmentNote(m.attachments)
  for (const d of Object.values(m.decisions ?? {})) text += `\n\n(The user ${d} a request card in this reply.)`
  return text
}

// earlier turns of the thread, newest kept first when it gets long
export function history(thread: Thread, skipLast: number): { role: 'user' | 'agent'; text: string }[] {
  const msgs = thread.messages
    .slice(0, thread.messages.length - skipLast)
    .filter((m) => m.text.trim() && (m.role === 'user' || m.status !== 'error'))
  const out: { role: 'user' | 'agent'; text: string }[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = turnText(msgs[i]).slice(0, MAX_TURN_CHARS)
    if (used + text.length > MAX_HISTORY_CHARS) break
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
