import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  IDEA_STAGES,
  isHttpUrl,
  PLATFORMS as SLOT_PLATFORMS,
  SOURCE_NAMES,
  STAGE_NAMES,
  STAT_PLATFORMS,
  TREND_SOURCES,
  WRITER_PLATFORMS,
  type Draft,
  type Idea,
  type IdeaStage,
  type PlatformDraft,
  type ScheduleSlot,
  type StatSnapshot,
  type TrendFeed,
  type WriterPlatform
} from '@shared/types'
import { buildContext, rankExamples, VOICE_PLATFORMS, type VoicePlatform } from '@shared/voice'
import { readJson, writeJson } from '../../analytics/files'
import { cleanWriterDoc } from '../../analytics/drafts'
import { cleanAnalyticsDoc } from '../../analytics/stats'
import { cleanIdeaBoard } from '../../planner/clean'
import { refreshTrends } from '../../trends'
import { loadVoice } from '../../voice/store'
import { ToolError, type GatewayTool } from '../types'
import { bool, int, list, obj, oneOf, str, type JsonSchema } from '../validate'
import { brandOf, changeBrand, clip, dataChanged, iso, parseWhen } from './common'

async function trendFeed(brandId: string): Promise<TrendFeed | null> {
  try {
    return JSON.parse(await fs.readFile(join(app.getPath('userData'), 'trends', `${brandId}.json`), 'utf8'))
  } catch {
    return null
  }
}

function ideaOut(i: Idea): Record<string, unknown> {
  return {
    id: i.id,
    title: i.title,
    url: i.url,
    source: i.source,
    stage: i.stage ?? 'idea',
    notes: i.notes ?? '',
    tags: i.tags ?? [],
    savedAt: iso(i.savedAt),
    postedAt: iso(i.postedAt)
  }
}

function slotOut(s: ScheduleSlot): Record<string, unknown> {
  return { id: s.id, at: iso(s.at), platform: s.platform, title: s.title, ideaId: s.ideaId, draft: clip(s.draft, 2000), done: s.done }
}

const filled = (p: PlatformDraft): boolean => Object.values(p.fields).some((v) => v.trim()) || p.thread.some((t) => t.trim())

function draftOut(d: Draft, full: boolean): Record<string, unknown> {
  const platforms: Record<string, unknown> = {}
  for (const p of WRITER_PLATFORMS) {
    const pd = d.platforms[p]
    if (!filled(pd)) continue
    platforms[p] = full
      ? { fields: pd.fields, thread: pd.thread, versions: pd.versions.length }
      : { fields: Object.keys(pd.fields).filter((k) => pd.fields[k].trim()), posts: pd.thread.length }
  }
  return { id: d.id, ideaId: d.ideaId, title: d.title, createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt), platforms }
}

async function loadDrafts(brandId: string) {
  return cleanWriterDoc(await readJson('writer', brandId))
}

const platformInput: JsonSchema = obj({
  fields: {
    type: 'object',
    description:
      'named text fields. youtube: title, description, tags. tiktok and instagram: caption, hashtags. reddit: title, body. x: use thread',
    additionalProperties: { type: 'string', maxLength: 40000 }
  },
  thread: list('x posts, one string per post in the thread', str('one post', 4000), 25)
})

const platformsInput: JsonSchema = {
  ...obj(Object.fromEntries(WRITER_PLATFORMS.map((p) => [p, platformInput]))),
  description: 'per platform text, only the platforms you are writing for'
}

function applyPlatforms(d: Draft, raw: Record<string, unknown> | undefined, now: number): string[] {
  const changed: string[] = []
  for (const p of WRITER_PLATFORMS) {
    const input = raw?.[p] as { fields?: Record<string, string>; thread?: string[] } | undefined
    if (!input) continue
    const cur = d.platforms[p]
    const fields = { ...cur.fields }
    for (const [k, v] of Object.entries(input.fields ?? {})) {
      if (!/^[a-z]{1,20}$/.test(k)) throw new ToolError(`field names are lowercase letters only, "${k}" isn't`)
      fields[k] = v
    }
    const thread = input.thread ?? cur.thread
    // the agent's text goes in as a version too, so the user can step back to what they had
    const versions = [{ id: randomUUID(), at: now, kind: 'generated' as const, fields, thread }, ...cur.versions].slice(0, 30)
    d.platforms[p] = { fields, thread, versions }
    changed.push(p)
  }
  return changed
}

function snapOut(s: StatSnapshot): Record<string, unknown> {
  return { at: iso(s.at), via: s.via, account: s.account, followers: s.followers, views: s.views, likes: s.likes, postCount: s.postCount }
}

export const CONTENT_TOOLS: GatewayTool[] = [
  // trends
  {
    name: 'trends_list',
    title: 'List trends',
    description: "What's trending for the current brand, ranked by growth score 0-100. Optional source filter.",
    inputSchema: obj({ source: oneOf('only this source', TREND_SOURCES), limit: int('max items, default 25', 1, 100) }),
    risk: 'read',
    run: async (turn, args) => {
      const feed = await trendFeed(turn.brandId)
      if (!feed) return 'no trends fetched yet. use trends_refresh to load them'
      const limit = Number(args.limit) || 25
      const items = feed.items
        .filter((i) => !args.source || i.source === args.source)
        .slice(0, limit)
        .map((i) => ({ id: i.id, source: SOURCE_NAMES[i.source], title: i.title, url: i.url, detail: i.detail, score: i.score }))
      return { fetchedAt: iso(feed.fetchedAt), errors: feed.errors, items }
    }
  },
  {
    name: 'trends_refresh',
    title: 'Refresh trends',
    description: "Fetch fresh trends for the brand's keywords and subreddits from Reddit, YouTube, Google Trends and TikTok. Takes a while. Then use trends_list.",
    inputSchema: obj(),
    risk: 'edit',
    annotations: { idempotentHint: true, openWorldHint: true },
    run: async (turn) => {
      brandOf(turn)
      await refreshTrends(turn.brandId)
      const feed = await trendFeed(turn.brandId)
      dataChanged(turn.brandId, 'trends')
      return { refreshed: true, items: feed?.items.length ?? 0, errors: feed?.errors ?? {} }
    }
  },

  // analytics
  {
    name: 'analytics_summary',
    title: 'Stats summary',
    description:
      "The brand's own numbers from its last analytics reads: followers, views and likes per platform, how they moved, and the best posts. The user refreshes these on the Analytics page.",
    inputSchema: obj({ platform: oneOf('only this platform', STAT_PLATFORMS), top: int('top posts per platform, default 5', 0, 25) }),
    risk: 'read',
    run: async (turn, args) => {
      const doc = cleanAnalyticsDoc(await readJson('analytics', turn.brandId))
      const top = args.top === undefined ? 5 : Number(args.top)
      const out: Record<string, unknown> = {}
      for (const p of STAT_PLATFORMS) {
        if (args.platform && p !== args.platform) continue
        const snaps = doc.snapshots.filter((s) => s.platform === p).sort((a, b) => a.at - b.at)
        const last = snaps[snaps.length - 1]
        if (!last) {
          out[p] = { read: false, lastRun: doc.lastRun[p] ?? null }
          continue
        }
        // the reading closest to a week before the last one
        const weekAgo = last.at - 7 * 86400_000
        const prev = [...snaps].reverse().find((s) => s.at <= weekAgo) ?? snaps[0]
        const delta = (a: number | null, b: number | null): number | null => (a !== null && b !== null && prev !== last ? a - b : null)
        out[p] = {
          read: true,
          latest: snapOut(last),
          change: { since: iso(prev.at), followers: delta(last.followers, prev.followers), views: delta(last.views, prev.views) },
          topPosts: [...last.posts]
            .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
            .slice(0, top)
            .map((x) => ({ title: x.title, url: x.url, publishedAt: iso(x.publishedAt), views: x.views, likes: x.likes, comments: x.comments })),
          readings: snaps.length,
          lastRun: doc.lastRun[p] ?? null
        }
      }
      return out
    }
  },

  // ideas
  {
    name: 'ideas_list',
    title: 'List ideas',
    description: `Ideas saved for the current brand, with their board stage (${IDEA_STAGES.join(', ')}), notes and tags.`,
    inputSchema: obj({
      stage: oneOf('only this stage', IDEA_STAGES),
      tag: str('only ideas with this tag', 30),
      query: str('words in the title or notes', 200)
    }),
    risk: 'read',
    run: async (turn, args) => {
      const q = typeof args.query === 'string' ? args.query.toLowerCase() : ''
      const tag = typeof args.tag === 'string' ? args.tag.toLowerCase() : ''
      return brandOf(turn)
        .ideas.filter((i) => !args.stage || (i.stage ?? 'idea') === args.stage)
        .filter((i) => !tag || (i.tags ?? []).includes(tag))
        .filter((i) => !q || `${i.title} ${i.notes ?? ''}`.toLowerCase().includes(q))
        .map(ideaOut)
    }
  },
  {
    name: 'idea_save',
    title: 'Save an idea',
    description: "Save a new idea to the current brand's Ideas board. Returns its id.",
    inputSchema: obj(
      {
        title: str('the idea', 300, 1),
        url: str('optional link it came from', 2000),
        notes: str('optional notes', 5000),
        tags: list('optional tags', str('tag', 30), 12),
        stage: oneOf('board column, default idea', IDEA_STAGES)
      },
      ['title']
    ),
    risk: 'edit',
    summarize: (_t, args) => `Save idea "${clip(String(args.title), 80)}"`,
    run: async (turn, args) => {
      const title = String(args.title).trim()
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (url && !isHttpUrl(url)) throw new ToolError('url has to be http or https')
      return changeBrand(turn.brandId, (b) => {
        const have = b.ideas.find((i) => i.title === title && i.url === url)
        if (have) return { saved: false, note: 'already saved', id: have.id }
        const idea: Idea = {
          id: randomUUID(),
          title,
          url,
          source: 'manual',
          savedAt: Date.now(),
          ...cleanIdeaBoard({ stage: args.stage as IdeaStage, notes: args.notes as string, tags: args.tags as string[] })
        }
        b.ideas.push(idea)
        return { saved: true, id: idea.id }
      })
    }
  },
  {
    name: 'idea_update',
    title: 'Edit an idea',
    description: 'Change the title, link, notes or tags of a saved idea. Only what you pass changes. tags replaces the list.',
    inputSchema: obj(
      {
        idea_id: str('id from ideas_list', 100, 1),
        title: str('new title', 300, 1),
        url: str('new link, empty to clear', 2000),
        notes: str('new notes', 5000),
        tags: list('new tags', str('tag', 30), 12)
      },
      ['idea_id']
    ),
    risk: 'edit',
    summarize: (_t, args) => `Edit idea ${args.idea_id}`,
    run: async (turn, args) => {
      if (typeof args.url === 'string' && args.url && !isHttpUrl(args.url)) throw new ToolError('url has to be http or https')
      return changeBrand(turn.brandId, (b) => {
        const i = b.ideas.find((x) => x.id === args.idea_id)
        if (!i) throw new ToolError(`no idea with id ${args.idea_id}, see ideas_list`)
        if (typeof args.title === 'string') i.title = args.title.trim()
        if (typeof args.url === 'string') i.url = args.url.trim()
        Object.assign(i, cleanIdeaBoard({ ...i, notes: (args.notes as string) ?? i.notes, tags: (args.tags as string[]) ?? i.tags }))
        return ideaOut(i)
      })
    }
  },
  {
    name: 'idea_move',
    title: 'Move an idea on the board',
    description: `Move an idea to another board stage: ${IDEA_STAGES.map((s) => `${s} (${STAGE_NAMES[s]})`).join(', ')}. Moving to posted stamps the time.`,
    inputSchema: obj({ idea_id: str('id from ideas_list', 100, 1), stage: oneOf('the new stage', IDEA_STAGES) }, ['idea_id', 'stage']),
    risk: 'edit',
    summarize: (_t, args) => `Move idea ${args.idea_id} to ${STAGE_NAMES[args.stage as IdeaStage]}`,
    run: async (turn, args) =>
      changeBrand(turn.brandId, (b) => {
        const i = b.ideas.find((x) => x.id === args.idea_id)
        if (!i) throw new ToolError(`no idea with id ${args.idea_id}, see ideas_list`)
        i.stage = args.stage as IdeaStage
        if (i.stage === 'posted' && !i.postedAt) i.postedAt = Date.now()
        return ideaOut(i)
      })
  },

  // schedule
  {
    name: 'schedule_list',
    title: 'List the schedule',
    description: "Planned posts on the brand's schedule, oldest first. Times are ISO. Done slots are left out unless include_done.",
    inputSchema: obj({
      from: str('ISO date, only slots at or after it', 40),
      to: str('ISO date, only slots before it', 40),
      include_done: bool('also show slots marked done')
    }),
    risk: 'read',
    run: async (turn, args) => {
      const from = typeof args.from === 'string' ? parseWhen(args.from, 'from', true) : 0
      const to = typeof args.to === 'string' ? parseWhen(args.to, 'to', true) : Infinity
      return (brandOf(turn).schedule ?? [])
        .filter((s) => s.at >= from && s.at < to && (args.include_done === true || !s.done))
        .sort((a, b) => a.at - b.at)
        .map(slotOut)
    }
  },
  {
    name: 'schedule_add',
    title: 'Add to the schedule',
    description: 'Put a planned post on the schedule. This only plans it, nothing gets posted. Returns the slot id.',
    inputSchema: obj(
      {
        at: str('when, ISO 8601', 40, 1),
        platform: oneOf('where it goes', SLOT_PLATFORMS),
        title: str('title or first line', 300),
        idea_id: str('optional idea id it is for', 100),
        draft: str('optional post text, caption or script notes', 20000)
      },
      ['at', 'platform']
    ),
    risk: 'edit',
    summarize: (_t, args) => `Schedule ${args.platform} "${clip(String(args.title ?? ''), 60)}" for ${args.at}`,
    run: async (turn, args) => {
      const at = parseWhen(String(args.at), 'at')
      return changeBrand(turn.brandId, (b) => {
        const ideaId = typeof args.idea_id === 'string' ? args.idea_id : ''
        if (ideaId && !b.ideas.some((i) => i.id === ideaId)) throw new ToolError(`no idea with id ${ideaId}`)
        const slot: ScheduleSlot = {
          id: randomUUID(),
          at,
          platform: String(args.platform),
          title: String(args.title ?? ''),
          ideaId,
          draft: String(args.draft ?? ''),
          done: false
        }
        b.schedule = [...(b.schedule ?? []), slot]
        return slotOut(slot)
      })
    }
  },
  {
    name: 'schedule_move',
    title: 'Move a scheduled slot',
    description: 'Move a schedule slot to a new time.',
    inputSchema: obj({ slot_id: str('id from schedule_list', 100, 1), at: str('new time, ISO 8601', 40, 1) }, ['slot_id', 'at']),
    risk: 'edit',
    summarize: (_t, args) => `Move schedule slot ${args.slot_id} to ${args.at}`,
    run: async (turn, args) => {
      const at = parseWhen(String(args.at), 'at')
      return changeBrand(turn.brandId, (b) => {
        const s = (b.schedule ?? []).find((x) => x.id === args.slot_id)
        if (!s) throw new ToolError(`no schedule slot with id ${args.slot_id}, see schedule_list`)
        s.at = at
        return slotOut(s)
      })
    }
  },
  {
    name: 'schedule_update',
    title: 'Edit a scheduled slot',
    description: 'Change the title, text, platform or done mark of a schedule slot. Only what you pass changes.',
    inputSchema: obj(
      {
        slot_id: str('id from schedule_list', 100, 1),
        title: str('new title', 300),
        draft: str('new post text or notes', 20000),
        platform: oneOf('new platform', SLOT_PLATFORMS),
        done: bool('mark done or not done')
      },
      ['slot_id']
    ),
    risk: 'edit',
    summarize: (_t, args) => `Edit schedule slot ${args.slot_id}`,
    run: async (turn, args) =>
      changeBrand(turn.brandId, (b) => {
        const s = (b.schedule ?? []).find((x) => x.id === args.slot_id)
        if (!s) throw new ToolError(`no schedule slot with id ${args.slot_id}, see schedule_list`)
        if (typeof args.title === 'string') s.title = args.title
        if (typeof args.draft === 'string') s.draft = args.draft
        if (typeof args.platform === 'string') s.platform = args.platform
        if (typeof args.done === 'boolean') s.done = args.done
        return slotOut(s)
      })
  },

  // writer
  {
    name: 'drafts_list',
    title: 'List drafts',
    description: 'Writer drafts for the current brand: id, title, linked idea and which platforms have text. Use draft_get for the text.',
    inputSchema: obj({ idea_id: str('only drafts for this idea', 100) }),
    risk: 'read',
    run: async (turn, args) =>
      (await loadDrafts(turn.brandId)).drafts
        .filter((d) => !args.idea_id || d.ideaId === args.idea_id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((d) => draftOut(d, false))
  },
  {
    name: 'draft_get',
    title: 'Read a draft',
    description: 'The full text of one writer draft, per platform.',
    inputSchema: obj({ draft_id: str('id from drafts_list', 100, 1) }, ['draft_id']),
    risk: 'read',
    run: async (turn, args) => {
      const d = (await loadDrafts(turn.brandId)).drafts.find((x) => x.id === args.draft_id)
      if (!d) throw new ToolError(`no draft with id ${args.draft_id}, see drafts_list`)
      return draftOut(d, true)
    }
  },
  {
    name: 'draft_create',
    title: 'Write a new draft',
    description: 'Start a writer draft for the current brand, optionally linked to an idea, with text per platform. Nothing gets posted. Returns its id.',
    inputSchema: obj({ title: str('draft title', 300, 1), idea_id: str('optional idea id', 100), platforms: platformsInput }, ['title']),
    risk: 'edit',
    summarize: (_t, args) => `Write draft "${clip(String(args.title), 80)}"`,
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const ideaId = typeof args.idea_id === 'string' ? args.idea_id : null
      if (ideaId && !brand.ideas.some((i) => i.id === ideaId)) throw new ToolError(`no idea with id ${ideaId}`)
      const doc = await loadDrafts(turn.brandId)
      const now = Date.now()
      const empty = (): PlatformDraft => ({ fields: {}, thread: [], versions: [] })
      const d: Draft = {
        id: randomUUID(),
        ideaId,
        title: String(args.title),
        createdAt: now,
        updatedAt: now,
        platforms: Object.fromEntries(WRITER_PLATFORMS.map((p) => [p, empty()])) as Record<WriterPlatform, PlatformDraft>
      }
      const changed = applyPlatforms(d, args.platforms as Record<string, unknown> | undefined, now)
      doc.drafts.unshift(d)
      await writeJson('writer', turn.brandId, cleanWriterDoc(doc))
      dataChanged(turn.brandId, 'writer')
      return { saved: true, id: d.id, platforms: changed }
    }
  },
  {
    name: 'draft_update',
    title: 'Edit a draft',
    description:
      'Change a writer draft. title replaces the title. For each platform you pass, the fields you name replace those fields and thread replaces the thread. The old text stays in the draft history.',
    inputSchema: obj({ draft_id: str('id from drafts_list', 100, 1), title: str('new title', 300, 1), platforms: platformsInput }, ['draft_id']),
    risk: 'edit',
    summarize: (_t, args) => `Edit draft ${args.draft_id}`,
    run: async (turn, args) => {
      const doc = await loadDrafts(turn.brandId)
      const d = doc.drafts.find((x) => x.id === args.draft_id)
      if (!d) throw new ToolError(`no draft with id ${args.draft_id}, see drafts_list`)
      const now = Date.now()
      if (typeof args.title === 'string') d.title = args.title
      const changed = applyPlatforms(d, args.platforms as Record<string, unknown> | undefined, now)
      d.updatedAt = now
      await writeJson('writer', turn.brandId, cleanWriterDoc(doc))
      dataChanged(turn.brandId, 'writer')
      return { saved: true, id: d.id, platforms: changed }
    }
  },

  // brand voice
  {
    name: 'voice_profile',
    title: 'Brand voice profile',
    description:
      'How the brand writes: who it is, audience, tone, topics, words and emoji it uses or avoids, calls to action, hashtags and notes per platform, plus how many sample posts there are.',
    inputSchema: obj(),
    risk: 'read',
    run: async (turn) => {
      const v = await loadVoice(turn.brandId)
      const { handles, ...profile } = v.profile
      return {
        profile: { ...profile, handles },
        summary: v.summaryText,
        samplePosts: v.posts.length,
        starred: v.posts.filter((p) => p.starred).length
      }
    }
  },
  {
    name: 'voice_samples',
    title: 'Brand voice sample posts',
    description: "The brand's own past posts that show its voice best: starred ones, the platform asked for, ones that did well and recent ones first.",
    inputSchema: obj({
      platform: oneOf('rank this platform first', VOICE_PLATFORMS),
      limit: int('how many, default 10', 1, 50),
      starred_only: bool('only posts the user starred')
    }),
    risk: 'read',
    run: async (turn, args) => {
      const v = await loadVoice(turn.brandId)
      const posts = rankExamples(
        v.posts.filter((p) => args.starred_only !== true || p.starred),
        args.platform as VoicePlatform | undefined
      )
      return posts.slice(0, Number(args.limit) || 10).map((p) => ({
        platform: p.platform,
        text: clip(p.text, 2000),
        url: p.url,
        postedAt: iso(p.postedAt),
        views: p.views,
        likes: p.likes,
        starred: p.starred,
        tags: p.tags
      }))
    }
  },
  {
    name: 'voice_context',
    title: 'Brand voice brief',
    description: 'The ready to use voice brief the app builds from the profile, summary and best examples, optionally for one platform.',
    inputSchema: obj({ platform: oneOf('write for this platform', VOICE_PLATFORMS), budget: int('max characters, default the brand setting', 500, 20000) }),
    risk: 'read',
    run: async (turn, args) => {
      const v = await loadVoice(turn.brandId)
      const ctx = buildContext(brandOf(turn).name, v, args.platform as VoicePlatform | undefined, Number(args.budget) || v.budget)
      return ctx.text
    }
  }
]
