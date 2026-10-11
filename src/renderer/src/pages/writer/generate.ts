import type { Brand, Draft, Idea, PlatformDraft } from '@shared/types'
import type { PlatformSpec } from './platforms'
import { draftChat } from '../voice/chatDraft'

// puts the prompt in the chat box and opens the chat. you read it and send it yourself,
// the writer never starts an agent
export function generateDraft(prompt: string, openChat: () => void): void {
  draftChat(prompt)
  openChat()
}

function shape(spec: PlatformSpec): string {
  if (spec.thread) {
    return `{"thread": ["post 1", "post 2"]}  (each post ${spec.thread.limit} characters at most, links count as 23, one post is fine)`
  }
  const keys = spec.fields.map((f) => `"${f.key}": "..."`).join(', ')
  const limits = spec.fields.map((f) => `${f.key} ${f.limit}`).join(', ')
  return `{${keys}}  (limits: ${limits})`
}

const NOTES: Partial<Record<PlatformSpec['id'], string>> = {
  youtube: 'tags is one comma separated string. Put the hook in the first two lines of the description.',
  tiktok: 'caption and hashtags share the 2200 limit. hashtags is one string like "#a #b".',
  instagram:
    'caption and hashtags share the 2200 limit, 30 hashtags at most. hashtags is one string like "#a #b".',
  reddit: 'Write like a person posting in the sub, not an ad. Body can use markdown.'
}

// a plain prompt the user sees and can change before it goes anywhere
export function buildPrompt(brand: Brand, draft: Draft, idea: Idea | undefined, spec: PlatformSpec): string {
  const d = draft.platforms[spec.id]
  const lines = [
    `Write a ${spec.name} post for my brand "${brand.name}".`,
    brand.keywords.length ? `Niche keywords: ${brand.keywords.join(', ')}.` : '',
    `Idea: ${idea?.title ?? draft.title}`,
    idea?.url ? `Source: ${idea.url}` : '',
    NOTES[spec.id] ?? '',
    currentText(spec, d),
    `Reply with only json in this shape: ${shape(spec)}`
  ]
  return lines.filter(Boolean).join('\n')
}

function currentText(spec: PlatformSpec, d: PlatformDraft): string {
  const parts = spec.thread
    ? d.thread.filter((p) => p.trim()).map((p, i) => `post ${i + 1}: ${p}`)
    : spec.fields.filter((f) => d.fields[f.key]?.trim()).map((f) => `${f.key}: ${d.fields[f.key]}`)
  return parts.length ? `What I have so far, keep what works:\n${parts.join('\n')}` : ''
}

// pulls the json out of whatever the agent said. if there's no json, the whole reply goes
// into the main field so nothing is lost
export function parseReply(
  spec: PlatformSpec,
  reply: string
): { fields: Record<string, string>; thread: string[] } {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
      if (spec.thread) {
        const t = Array.isArray(obj.thread) ? obj.thread.filter((p) => typeof p === 'string') : []
        if (t.length) return { fields: {}, thread: t as string[] }
      } else {
        const fields: Record<string, string> = {}
        for (const f of spec.fields) {
          const v = obj[f.key]
          if (typeof v === 'string') fields[f.key] = v
          else if (Array.isArray(v)) fields[f.key] = v.join(f.key === 'tags' ? ', ' : ' ')
        }
        if (Object.keys(fields).length) return { fields, thread: [] }
      }
    } catch {
      // not json after all, fall through
    }
  }
  const text = reply.trim()
  if (spec.thread) return { fields: {}, thread: [text] }
  const main = spec.fields.find((f) => f.rows > 2) ?? spec.fields[0]
  return { fields: { [main.key]: text }, thread: [] }
}
