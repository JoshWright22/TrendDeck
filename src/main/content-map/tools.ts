import { clock, ratioText, SNAPSHOT_NAMES, type MapRow } from '@shared/content-map'
import type { ContentMapCard } from '@shared/cards'
import { addCard, newCardId } from '../cards/store'
import { brandOf, iso } from '../gateway/tools/common'
import { ToolError, type GatewayTool } from '../gateway/types'
import { list, obj, oneOf, str } from '../gateway/validate'
import { similar, whatWorked } from './baseline'
import { changed, findVideo, mapView, setPillars, sync, videoDetail } from './service'
import { loadMap } from './store'

// what the agent reads from the content map. all read except pillar_propose, which saves under the edit rule.
// the agent gets numbers and titles, never how the channel is signed in

const row = (r: MapRow): Record<string, unknown> => ({
  videoId: r.id,
  title: r.title,
  platform: r.platform,
  format: r.format,
  published: iso(r.publishedAt),
  views: r.views,
  vsBaseline: r.ratio === null ? null : ratioText(r.ratio),
  flag: r.flag,
  pillar: r.pillar,
  hookStyle: r.hookStyle,
  titleStyle: r.titleStyle,
  ...(r.avgViewPercent !== null ? { avgViewPercent: Math.round(r.avgViewPercent) } : {})
})

const NOT_SET_UP =
  "The content map is empty. The creator connects their channel in Settings, Channels (YouTube with Google, or a public channel handle). TrendDeck's own project folders are mapped too once a project has a script or an export."

const REF = str('The video id, its YouTube link, or a few words of its title.', 300, 2)

export const CONTENT_MAP_TOOLS: GatewayTool[] = [
  {
    name: 'content_map',
    title: 'Read the content map',
    risk: 'read',
    description:
      "The brand's content map: the channel's own baseline per format (median of the last 10 comparable videos older than a week), pillars with their median against baseline, the top and bottom videos, recurring keywords and what isn't available. Ratios are views (engaged views for Shorts) over the baseline at the time the video came out. Use it when planning a new video and say which past videos you build on.",
    inputSchema: obj(),
    run: async (turn) => {
      brandOf(turn)
      let m = await loadMap(turn.brandId)
      if (!m.lastSync && (m.publicChannel || m.channelId)) {
        await sync(turn.brandId).catch(() => null)
        m = await loadMap(turn.brandId)
      }
      const v = await mapView(turn.brandId)
      if (!v.rows.length) return NOT_SET_UP
      const settled = v.rows.filter((r) => r.ratio !== null && r.flag !== 'early')
      const byRatio = [...settled].sort((a, b) => (b.ratio as number) - (a.ratio as number))
      return {
        channel: { title: v.channel.channelTitle || null, via: v.channel.mode, lastSync: iso(v.channel.lastSync), note: v.channel.lastSyncNote || null },
        videos: v.rows.length,
        baselines: v.baselines.map((b) => ({ platform: b.platform, format: b.format, median: b.median, of: `${b.count} recent videos`, metric: b.metric })),
        pillars: v.pillars.length
          ? v.pillars.map((p) => ({ pillar: p.label, keywords: p.keywords, videos: p.count, medianVsBaseline: p.median === null ? null : ratioText(p.median), beatBaseline: p.beat === null ? null : `${Math.round(p.beat * 100)}%`, best: p.best.map((b) => `${b.title} (${ratioText(b.ratio)})`) }))
          : 'No pillars yet. Propose some with pillar_propose from the keywords below and the brand positioning.',
        top: byRatio.slice(0, 5).map(row),
        bottom: byRatio.slice(-5).reverse().filter((r) => !byRatio.slice(0, 5).includes(r)).map(row),
        newest: v.rows.filter((r) => r.flag === 'early').slice(0, 5).map(row),
        notPosted: v.rows.filter((r) => r.platform === 'local').map((r) => r.title).slice(0, 10),
        keywords: v.keywords.slice(0, 15).map((k) => `${k.word} (${k.count})`),
        unavailable: [
          ...(v.channel.mode !== 'oauth' ? ['watch time, retention and subscribers: the channel is not connected with Google'] : []),
          ...(v.channel.csvImportedAt ? [] : ['impressions and CTR: only from a YouTube Studio export the creator imports in Settings, Channels'])
        ]
      }
    }
  },
  {
    name: 'video_stats',
    title: 'Read one video\'s numbers',
    risk: 'read',
    description: 'Everything the content map has on one past video: metrics, ratio against the baseline, post-publish snapshots, hook (first 30 s), pacing, pillar, its project and retention at 30 s.',
    inputSchema: obj({ videoId: REF }, ['videoId']),
    run: async (turn, args) => {
      brandOf(turn)
      const v = await findVideo(turn.brandId, args.videoId as string)
      if (!v) throw new ToolError(`No video in the content map matches "${args.videoId as string}". content_map lists them.`)
      const d = await videoDetail(turn.brandId, v.id)
      if (!d) throw new ToolError('That video is gone from the map.')
      return {
        ...row(d.row),
        url: v.url || null,
        duration: v.duration === null ? null : clock(v.duration),
        baseline: d.row.baseline,
        metrics: v.metrics,
        tags: v.tags,
        thumbnailText: v.thumbnailText || null,
        hook: v.hook ? { text: v.hook, from: v.hookSource } : null,
        pacing: v.pacing,
        projectId: v.projectId,
        snapshots: d.snapshots.map((s) => ({ at: SNAPSHOT_NAMES[s.label], views: s.views, engagedViews: s.engagedViews, likes: s.likes, comments: s.comments, avgViewPercent: s.avgViewPercent, late: s.at - s.due > 3600_000 })),
        retention: v.retention.length > 1 ? { at30s: d.retention.at30, dips: d.retention.dips.length, use: 'retention_dips for where people left' } : 'no retention curve (needs the Google connection and about 100 views)'
      }
    }
  },
  {
    name: 'similar_videos',
    title: 'Find similar past videos',
    risk: 'read',
    description: 'Past videos closest to an idea or a bit of script, by title, tags, hook and description, with how each did against its baseline. Use it before planning so you can build on what worked and say which videos you mean.',
    inputSchema: obj({ text: str('The idea, working title or script text.', 2000, 3) }, ['text']),
    run: async (turn, args) => {
      brandOf(turn)
      const m = await loadMap(turn.brandId)
      if (!m.videos.length) return NOT_SET_UP
      const hits = similar(m.videos, args.text as string, 6)
      if (!hits.length) return 'No past video is close to that.'
      const view = await mapView(turn.brandId)
      const byId = new Map(view.rows.map((r) => [r.id, r]))
      return hits.map((h) => ({ ...row(byId.get(h.video.id) as MapRow), similarity: h.score, hook: h.video.hook.slice(0, 200) || null }))
    }
  },
  {
    name: 'what_worked',
    title: 'What beat the baseline',
    risk: 'read',
    description: "Groups the channel's settled videos by pillar, format, hook style and title style, with each group's median against baseline, how many beat it and the best examples. Narrow it with format or pillar.",
    inputSchema: obj({ format: oneOf('long or short', ['long', 'short']), pillar: str('A pillar label from content_map.', 60, 1) }),
    run: async (turn, args) => {
      brandOf(turn)
      const v = await mapView(turn.brandId)
      if (!v.rows.length) return NOT_SET_UP
      const w = whatWorked(v.rows, { format: args.format as string | undefined, pillar: args.pillar as string | undefined })
      const fmt = (g: (typeof w)['pillar']): unknown[] =>
        g.map((x) => ({ group: x.key, videos: x.count, medianVsBaseline: x.median === null ? null : ratioText(x.median), beatBaseline: x.beat === null ? null : `${Math.round(x.beat * 100)}%`, best: x.best.map((b) => `${b.title} (${ratioText(b.ratio)})`) }))
      return { note: 'Ratios are against the channel\'s own baseline, a group of 1 or 2 videos is weak evidence.', pillar: fmt(w.pillar), format: fmt(w.format), hookStyle: fmt(w.hookStyle), titleStyle: fmt(w.titleStyle) }
    }
  },
  {
    name: 'retention_dips',
    title: 'Where people left a video',
    risk: 'read',
    description: 'The retention curve of one video turned into dips with timestamps, how much of the audience left and, when the project has captions or a take with times, the script line said there. recurring means other recent videos dropped at the same point.',
    inputSchema: obj({ videoId: REF }, ['videoId']),
    run: async (turn, args) => {
      brandOf(turn)
      const v = await findVideo(turn.brandId, args.videoId as string)
      if (!v) throw new ToolError(`No video in the content map matches "${args.videoId as string}".`)
      if (v.retention.length < 2) return `No retention curve for "${v.title}". It needs the channel connected with Google in Settings, Channels, about 100 views, and YouTube takes 2 to 3 days to process it.`
      const d = await videoDetail(turn.brandId, v.id)
      if (!d) throw new ToolError('That video is gone from the map.')
      return {
        title: v.title,
        duration: v.duration === null ? null : clock(v.duration),
        stillWatchingAt30s: d.retention.at30 === null ? null : `${Math.round(d.retention.at30 * 100)}%`,
        dips: d.retention.dips.map((x) => ({ from: clock(x.from), to: clock(x.to), left: `${Math.round(x.drop * 100)}%`, steeperThanUsual: `${x.steepness}x`, line: x.line || null, lineFrom: x.lineSource || null, recurring: x.recurring })),
        rewatched: d.retention.spikes.map((s) => clock(s.at)),
        note: v.projectId ? null : 'This video is not matched to a TrendDeck project, so dips have no lines.'
      }
    }
  },
  {
    name: 'pillar_propose',
    title: 'Set the content pillars',
    risk: 'edit',
    description:
      "Saves the brand's content pillars (the kinds of video the channel makes): a short label each and the keywords that put a video in it (matched against titles, tags and descriptions). It saves right away and works before a channel is connected or positioning.md is written. The creator sees and removes them in Settings, Channels. mode add keeps the existing ones (a same label is replaced), replace swaps them all.",
    inputSchema: obj(
      {
        pillars: list('1 to 8 pillars', obj({ label: str('Short label, e.g. "Budget builds"', 60, 2), keywords: list('Keywords or short phrases', str('keyword', 40, 2), 20, 1), why: str('One line on why', 300) }, ['label', 'keywords']), 8, 1),
        mode: oneOf('add (default) or replace', ['add', 'replace'])
      },
      ['pillars']
    ),
    summarize: (turn, args) => {
      const p = (args.pillars as { label: string; keywords: string[] }[]) ?? []
      return `${args.mode === 'replace' ? 'Replace the pillars with' : 'Add pillars'} for ${brandOf(turn).name}: ${p.map((x) => `${x.label} (${x.keywords.slice(0, 4).join(', ')})`).join('; ')}`
    },
    // saves straight away under the edit rule. it used to always wait for an approval, and agents
    // give up on a tool call long before the approval timed out, so it came back as a timeout
    run: async (turn, args) => {
      brandOf(turn)
      const items = (args.pillars as { label: string; keywords: string[]; why?: string }[]).map((p) => ({ label: p.label, keywords: p.keywords, why: p.why ?? '' }))
      const all = await setPillars(turn.brandId, items, args.mode === 'replace' ? 'replace' : 'add')
      changed(turn.brandId)
      const v = await mapView(turn.brandId)
      const counts = v.rows.length ? `videos per pillar: ${v.pillars.map((p) => `${p.label} ${p.count}`).join(', ')}` : 'no past videos are mapped yet, they are sorted into pillars once the channel is connected in Settings, Channels'
      return `saved. the brand's pillars are now: ${all.map((p) => p.label).join(', ')}. ${counts}. the creator can remove them in Settings, Channels`
    }
  },
  {
    name: 'show_content_map',
    title: 'Show the content map',
    risk: 'read',
    description: 'Puts the content map in the chat as a card: pillars with counts and median against baseline, every video sortable by its ratio, and a retention curve with dips for the one you click. Pass videoId to open one video.',
    inputSchema: obj({ note: str('One line on what to look at.', 300), videoId: REF }),
    run: async (turn, args) => {
      brandOf(turn)
      let focus: string | null = null
      if (typeof args.videoId === 'string') {
        const v = await findVideo(turn.brandId, args.videoId)
        if (!v) throw new ToolError(`No video in the content map matches "${args.videoId}".`)
        focus = v.id
      }
      const now = Date.now()
      const card: ContentMapCard = { id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now, type: 'content-map', note: typeof args.note === 'string' ? args.note.trim() : '', focus }
      await addCard(card)
      return `shown as card ${card.id}`
    }
  }
]
