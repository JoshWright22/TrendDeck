import { BrowserWindow, dialog, nativeImage, session } from 'electron'
import { partitionFor } from '@shared/types'
import { PLATFORM_NAMES, PLATFORM_RULES, PLATFORMS, type Platform, type PostStatus } from '@shared/posting'
import { SHORT_LIMITS, SHORT_PLATFORMS, type ShortPlatform } from '@shared/reuse'
import { blockKey, INBOX_SITES, inboxSiteOf } from '@shared/inbox'
import { hostOf } from '@shared/types'
import type { MediaKind } from '@shared/media'
import { getMedia, listMedia } from '../../media'
import { addFiles } from '../../media/library'
import { queueAgentPost } from '../../posting'
import { allPosts, brandSettings, getState as postingState } from '../../posting/store'
import { listShorts } from '../../reuse'
import { refresh as refreshInbox, reply as typeReply } from '../../inbox'
import { loadInbox, saveInbox } from '../../inbox/store'
import { checkSites } from '../../inbox/health'
import { grabFrame, phoneStatus, sendInput } from '../../emulator/device'
import { checkUpload } from '../../mcp/tools'
import { addLog } from '../../mcp/state'
import { ImageResult, ToolError, type GatewayTool, type Turn } from '../types'
import { bool, int, list, obj, oneOf, str } from '../validate'
import { brandOf, clip, dataChanged, iso, parseWhen } from './common'
import { addReplyDraft, findReplyDraft, markReplySent } from '../replies'

const POST_STATUSES: PostStatus[] = ['draft', 'scheduled', 'queued', 'running', 'review', 'posted', 'failed', 'closed', 'missed']

// the app's own window, where dialogs belong. posting and inbox windows show sites
function appWindow(): BrowserWindow | null {
  const dev = process.env.ELECTRON_RENDERER_URL ?? ''
  return (
    BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed()) return false
      const url = w.webContents.getURL()
      return url.startsWith('file:') || (!!dev && url.startsWith(dev))
    }) ?? null
  )
}

function postNote(brandId: string): string {
  return brandSettings(brandId).autoPost
    ? 'this brand posts without a check, it goes out when its turn comes'
    : 'the user checks it in the site and presses Post themselves, see posting_list for how it went'
}

async function mediaName(turn: Turn, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !id) return ''
  const m = await getMedia(id)
  return m && m.brandId === turn.brandId ? `${m.name}.${m.ext}` : id
}

// phone screenshots are scaled down for the agent, taps get scaled back up
const phoneScale = new Map<string, number>()
const PHONE_MAX_W = 720

export const PUBLISH_TOOLS: GatewayTool[] = [
  // media library
  {
    name: 'media_list',
    title: 'List media',
    description:
      "Files in this brand's media library the user allowed for agents: id, name, type, size, length, tags and where each was posted. No paths. Use the ids with upload_file, request_post and shorts_queue.",
    inputSchema: obj({
      query: str('name or tag to search for', 200),
      kind: oneOf('only this kind', ['video', 'image', 'audio', 'file']),
      tag: str('only files with this tag', 60),
      not_posted_to: str('only files never posted to this platform, or "any" for never posted anywhere', 30)
    }),
    risk: 'read',
    run: async (turn, args) =>
      listMedia(turn.brandId, {
        ...(args.query ? { query: String(args.query) } : {}),
        ...(args.kind ? { kind: args.kind as MediaKind } : {}),
        ...(args.tag ? { tag: String(args.tag) } : {}),
        ...(args.not_posted_to ? { notPostedTo: args.not_posted_to === 'any' ? true : String(args.not_posted_to) } : {})
      })
  },
  {
    name: 'media_get',
    title: 'Media details',
    description: 'Details of one media file by id: name, type, size, length, frame size, tags and where it was posted. No path.',
    inputSchema: obj({ media_id: str('id from media_list', 100, 1) }, ['media_id']),
    risk: 'read',
    run: async (turn, args) => {
      const m = await getMedia(String(args.media_id))
      if (!m || m.brandId !== turn.brandId) throw new ToolError(`no media with id ${args.media_id} that agents may use, see media_list`)
      return m
    }
  },
  {
    name: 'media_import',
    title: 'Ask the user for files',
    description:
      "Open a file picker so the user can add files to the brand's media library, e.g. a video they recorded. You never see paths, only the new ids. The user can cancel.",
    inputSchema: obj({ reason: str('what you need, shown on the picker, e.g. "Pick the video for the unboxing short"', 120, 1) }, ['reason']),
    risk: 'edit',
    summarize: (_t, args) => `Ask for files: ${args.reason}`,
    run: async (turn, args) => {
      brandOf(turn)
      const win = appWindow()
      if (!win) throw new ToolError('the app window is closed')
      if (win.isMinimized()) win.restore()
      win.focus()
      const opts: Electron.OpenDialogOptions = { title: String(args.reason), properties: ['openFile', 'multiSelections'] }
      const res = await dialog.showOpenDialog(win, opts)
      if (res.canceled || res.filePaths.length === 0) return { added: 0, note: 'the user cancelled' }
      const out = await addFiles(turn.brandId, res.filePaths)
      const files = await Promise.all(out.ids.map((id) => getMedia(id)))
      dataChanged(turn.brandId, 'media')
      return {
        added: out.added,
        skipped: out.skipped,
        files: files.filter((m) => m !== null).map((m) => ({ id: m.id, name: m.name, kind: m.kind, ext: m.ext, size: m.size }))
      }
    }
  },

  // posting
  {
    name: 'request_post',
    title: 'Queue a post',
    description:
      "Post something for this brand. TrendDeck opens the site in the brand's own session, fills the post in and waits for the user to check it and press Post. It goes out only when they do, unless they turned that check off for this brand. Media comes from media_list ids.",
    inputSchema: obj(
      {
        platform: oneOf('where it goes', PLATFORMS),
        title: str('title, needed for youtube and reddit', 300),
        body: str('the post text, caption or description', 40000, 1),
        media_id: str('media id from media_list, needed for youtube, tiktok and instagram', 100),
        subreddit: str('reddit only, without r/', 30),
        when: str('optional time to post, ISO 8601. empty means now', 40)
      },
      ['platform', 'body']
    ),
    risk: 'publish',
    summarize: async (turn, args) => {
      const p = PLATFORM_NAMES[args.platform as Platform]
      const media = await mediaName(turn, args.media_id)
      const when = args.when ? ` at ${args.when}` : ' now'
      return `Post on ${p}${when}: "${clip(String(args.title || args.body), 100)}"${media ? ` with ${media}` : ''}`
    },
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const platform = args.platform as Platform
      const rules = PLATFORM_RULES[platform]
      const body = String(args.body)
      const title = String(args.title ?? '')
      if (rules.needsTitle && !title.trim()) throw new ToolError(`${PLATFORM_NAMES[platform]} needs a title`)
      if (body.length > rules.bodyMax) throw new ToolError(`${PLATFORM_NAMES[platform]} takes at most ${rules.bodyMax} characters of text`)
      const mediaId = typeof args.media_id === 'string' ? args.media_id : ''
      if (rules.needsMedia && !mediaId) throw new ToolError(`${PLATFORM_NAMES[platform]} needs a media_id`)
      const when = args.when ? parseWhen(String(args.when), 'when') : 0
      // checked now so the agent hears about a file it can't use right away
      if (mediaId) await checkUpload(turn, mediaId)
      const post = await queueAgentPost({
        brandId: brand.id,
        platform,
        title,
        body,
        mediaId,
        mediaUrl: '',
        subreddit: String(args.subreddit ?? '').replace(/^r\//, ''),
        visibility: 'public',
        scheduledAt: when || null
      })
      await addLog({ brandId: brand.id, siteId: '', kind: 'post-request', detail: `${platform}: ${post.title.slice(0, 60)}` })
      dataChanged(brand.id, 'posting')
      return { queued: true, id: post.id, status: post.status, note: postNote(brand.id) }
    }
  },
  {
    name: 'posting_list',
    title: 'Posting queue and log',
    description: "This brand's posts in the posting queue with their status, and the latest posting log entries.",
    inputSchema: obj({ status: oneOf('only posts with this status', POST_STATUSES), limit: int('max posts, default 30', 1, 200) }),
    risk: 'read',
    run: async (turn, args) => {
      const limit = Number(args.limit) || 30
      const posts = allPosts()
        .filter((p) => p.brandId === turn.brandId && (!args.status || p.status === args.status))
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          platform: p.platform,
          title: p.title,
          body: clip(p.body, 300),
          mediaId: p.mediaId,
          status: p.status,
          scheduledAt: iso(p.scheduledAt),
          byAgent: p.byAgent,
          note: p.note,
          url: p.url,
          updatedAt: iso(p.updatedAt)
        }))
      const log = postingState()
        .log.filter((l) => l.brandId === turn.brandId)
        .slice(0, 20)
        .map((l) => ({ at: iso(l.at), postId: l.postId, platform: l.platform, result: l.result, message: l.message }))
      return { checkBeforePosting: !brandSettings(turn.brandId).autoPost, posts, log }
    }
  },
  {
    name: 'shorts_queue',
    title: 'Queue a short video',
    description:
      'Post one short vertical video to several places at once: YouTube Shorts, Instagram Reels and TikTok. Each one goes through the posting queue and its post check like request_post.',
    inputSchema: obj(
      {
        media_id: str('video id from media_list', 100, 1),
        platforms: list('where it goes', oneOf('platform', SHORT_PLATFORMS), 3, 1),
        caption: str('caption or description', 5000, 1),
        title: str('youtube title', 100),
        when: str('optional time to post, ISO 8601. empty means now', 40)
      },
      ['media_id', 'platforms', 'caption']
    ),
    risk: 'publish',
    summarize: async (turn, args) =>
      `Post short ${await mediaName(turn, args.media_id)} to ${(args.platforms as string[]).join(', ')}${args.when ? ` at ${args.when}` : ' now'}: "${clip(String(args.caption), 100)}"`,
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const platforms = [...new Set(args.platforms as ShortPlatform[])]
      const caption = String(args.caption)
      const title = String(args.title ?? '')
      for (const p of platforms) {
        const lim = SHORT_LIMITS[p]
        if (caption.length > lim.captionMax) throw new ToolError(`${p} takes at most ${lim.captionMax} characters of caption`)
        if (p === 'youtube' && !title.trim()) throw new ToolError('youtube needs a title')
      }
      const mediaId = String(args.media_id)
      await checkUpload(turn, mediaId)
      const m = await getMedia(mediaId)
      if (m && m.kind !== 'video') throw new ToolError(`${m.name} isn't a video`)
      const when = args.when ? parseWhen(String(args.when), 'when') : 0
      const queued: { platform: string; id: string; status: string }[] = []
      for (const p of platforms) {
        const post = await queueAgentPost({
          brandId: brand.id,
          platform: p,
          title: p === 'youtube' ? title : '',
          body: caption,
          mediaId,
          mediaUrl: '',
          subreddit: '',
          visibility: 'public',
          scheduledAt: when || null
        })
        queued.push({ platform: p, id: post.id, status: post.status })
        await addLog({ brandId: brand.id, siteId: '', kind: 'post-request', detail: `${p} short: ${clip(caption, 60)}` })
      }
      dataChanged(brand.id, 'posting')
      return { queued, note: postNote(brand.id) }
    }
  },
  {
    name: 'shorts_list_channel',
    title: "List a channel's shorts",
    description: "The Shorts on a YouTube channel (title, url, views), read with the brand's own YouTube session. Good for finding shorts to reuse.",
    inputSchema: obj({ channel_url: str('channel url or @handle', 300, 1) }, ['channel_url']),
    risk: 'read',
    annotations: { openWorldHint: true },
    run: async (turn, args) => {
      brandOf(turn)
      const res = await listShorts(turn.brandId, String(args.channel_url))
      if (res.error && !res.shorts.length) throw new ToolError(res.error)
      return res
    }
  },

  // inbox
  {
    name: 'inbox_list',
    title: 'List comments',
    description: "Comments on the brand's posts from its inbox, newest first. Blocked authors are left out. Use inbox_refresh to read the sites again.",
    inputSchema: obj({
      unread_only: bool('only unread comments'),
      site: oneOf('only this site', INBOX_SITES),
      limit: int('max comments, default 30', 1, 200)
    }),
    risk: 'read',
    run: async (turn, args) => {
      const inbox = await loadInbox(turn.brandId)
      const blocked = new Set(inbox.blocked)
      const limit = Number(args.limit) || 30
      return {
        refreshedAt: iso(inbox.refreshedAt),
        comments: inbox.comments
          .filter((c) => !blocked.has(blockKey(c)))
          .filter((c) => args.unread_only !== true || !c.read)
          .filter((c) => !args.site || c.site === args.site)
          .slice(0, limit)
          .map((c) => ({ id: c.id, site: c.site, account: c.account, author: c.author, text: c.text, postTitle: c.postTitle, url: c.url, at: iso(c.at), read: c.read }))
      }
    }
  },
  {
    name: 'inbox_refresh',
    title: 'Read new comments',
    description: "Read new comments from every site the brand is signed in on. Takes a while, opens hidden pages in the brand's session.",
    inputSchema: obj(),
    risk: 'read',
    annotations: { openWorldHint: true, idempotentHint: false },
    run: async (turn) => {
      brandOf(turn)
      const results = await refreshInbox(turn.brandId)
      dataChanged(turn.brandId, 'inbox')
      return results
    }
  },
  {
    name: 'inbox_mark_read',
    title: 'Mark comments read',
    description: 'Mark inbox comments read or unread.',
    inputSchema: obj({ comment_ids: list('ids from inbox_list', str('comment id', 300), 200, 1), read: bool('true for read, false for unread') }, ['comment_ids', 'read']),
    risk: 'edit',
    run: async (turn, args) => {
      const want = new Set(args.comment_ids as string[])
      const inbox = await loadInbox(turn.brandId)
      let n = 0
      for (const c of inbox.comments) {
        if (want.has(c.id)) {
          c.read = args.read === true
          n++
        }
      }
      await saveInbox(turn.brandId, inbox)
      dataChanged(turn.brandId, 'inbox')
      return { changed: n }
    }
  },
  {
    name: 'inbox_draft_reply',
    title: 'Draft a reply',
    description: 'Save a reply to a comment as a draft the user can see. Nothing is sent. inbox_send_reply sends it.',
    inputSchema: obj({ comment_id: str('id from inbox_list', 300, 1), text: str('the reply', 10000, 1) }, ['comment_id', 'text']),
    risk: 'edit',
    summarize: (_t, args) => `Draft a reply: "${clip(String(args.text), 100)}"`,
    run: async (turn, args) => {
      const inbox = await loadInbox(turn.brandId)
      const c = inbox.comments.find((x) => x.id === args.comment_id)
      if (!c) throw new ToolError(`no comment with id ${args.comment_id}, see inbox_list`)
      const d = await addReplyDraft(turn.brandId, c.id, String(args.text))
      return { saved: true, id: d.id, commentId: c.id }
    }
  },
  {
    name: 'inbox_send_reply',
    title: 'Send a reply',
    description:
      "Reply to a comment on its site, with text or the saved draft for that comment. TrendDeck opens the comment in the brand's session and types the reply in, the user presses the site's Reply button.",
    inputSchema: obj({ comment_id: str('id from inbox_list', 300, 1), text: str('the reply, leave out to use the saved draft', 10000) }, ['comment_id']),
    risk: 'publish',
    summarize: async (turn, args) => {
      const c = (await loadInbox(turn.brandId)).comments.find((x) => x.id === args.comment_id)
      const draft = await findReplyDraft(turn.brandId, String(args.comment_id))
      const text = typeof args.text === 'string' ? args.text : (draft?.text ?? '')
      return `Reply to ${c ? `${c.author} on ${c.site}` : 'a comment'}: "${clip(text, 120)}"`
    },
    run: async (turn, args) => {
      const id = String(args.comment_id)
      const draft = await findReplyDraft(turn.brandId, id)
      const text = typeof args.text === 'string' ? args.text : (draft?.text ?? '')
      if (!text.trim()) throw new ToolError('give text, or save a draft with inbox_draft_reply first')
      const res = await typeReply(turn.brandId, id, text)
      if (!res.ok) throw new ToolError(res.message)
      await markReplySent(turn.brandId, id)
      return res.message
    }
  },

  // sign-in state, yes or no only
  {
    name: 'login_status',
    title: 'Which sites are signed in',
    description: "Whether the brand is signed in on each of its sites: yes, no or unknown. Nothing else about the session. Use login to sign in with a saved login.",
    inputSchema: obj(),
    risk: 'read',
    run: async (turn) => {
      const brand = brandOf(turn)
      const health = await checkSites(session.fromPartition(partitionFor(brand.id)), brand.sites)
      return brand.sites.map((s) => {
        const h = health[s.id]?.state
        return {
          siteId: s.id,
          site: s.name,
          signedIn: h === 'in' ? 'yes' : h === 'out' ? 'no' : 'unknown',
          inboxSite: inboxSiteOf(hostOf(s.url)) !== null
        }
      })
    }
  },

  // the brand's android phone
  {
    name: 'phone_screenshot',
    title: 'See the phone screen',
    description: "A picture of the brand's phone screen, scaled down. phone_input takes coordinates in this picture. The phone has to be on.",
    inputSchema: obj(),
    risk: 'read',
    annotations: { idempotentHint: false },
    run: async (turn) => {
      const st = phoneStatus(turn.brandId)
      if (st.state !== 'on') throw new ToolError(`the phone is ${st.state}. the user starts it on the Phone page`)
      const f = await grabFrame(turn.brandId)
      if (!f) throw new ToolError("couldn't grab the screen, try again")
      // screencap is rgba, nativeImage wants bgra
      const bgra = Buffer.from(f.pixels)
      for (let i = 0; i < bgra.length; i += 4) {
        const r = bgra[i]
        bgra[i] = bgra[i + 2]
        bgra[i + 2] = r
      }
      let img = nativeImage.createFromBitmap(bgra, { width: f.width, height: f.height })
      const scale = f.width > PHONE_MAX_W ? f.width / PHONE_MAX_W : 1
      if (scale > 1) img = img.resize({ width: PHONE_MAX_W, quality: 'good' })
      phoneScale.set(turn.brandId, scale)
      const size = img.getSize()
      return new ImageResult(img.toPNG(), `phone screen, ${size.width}x${size.height}`)
    }
  },
  {
    name: 'phone_input',
    title: 'Use the phone',
    description:
      "Tap, swipe, type or press a key on the brand's phone. Coordinates are in the last phone_screenshot. Take a new screenshot after to see what happened.",
    inputSchema: obj(
      {
        action: oneOf('what to do', ['tap', 'swipe', 'type', 'key']),
        x: int('tap or swipe start x', 0, 10000),
        y: int('tap or swipe start y', 0, 10000),
        x2: int('swipe end x', 0, 10000),
        y2: int('swipe end y', 0, 10000),
        text: str('text to type, plain ascii', 500),
        key: oneOf('key to press', ['back', 'home', 'recents', 'del', 'enter', 'tab', 'up', 'down', 'left', 'right'])
      },
      ['action']
    ),
    risk: 'publish',
    summarize: (_t, args) =>
      args.action === 'type'
        ? `Type "${clip(String(args.text ?? ''), 80)}" on the phone`
        : args.action === 'key'
          ? `Press ${args.key} on the phone`
          : `${args.action === 'tap' ? 'Tap' : 'Swipe'} on the phone at ${args.x},${args.y}`,
    run: async (turn, args) => {
      if (phoneStatus(turn.brandId).state !== 'on') throw new ToolError('the phone is off')
      const s = phoneScale.get(turn.brandId) ?? 1
      const px = (n: unknown, name: string): number => {
        if (typeof n !== 'number') throw new ToolError(`${args.action} needs ${name}`)
        return Math.round(n * s)
      }
      try {
        if (args.action === 'tap') sendInput(turn.brandId, { type: 'tap', x: px(args.x, 'x'), y: px(args.y, 'y') })
        else if (args.action === 'swipe') {
          sendInput(turn.brandId, { type: 'swipe', x1: px(args.x, 'x'), y1: px(args.y, 'y'), x2: px(args.x2, 'x2'), y2: px(args.y2, 'y2'), ms: 300 })
        } else if (args.action === 'type') {
          if (typeof args.text !== 'string' || !args.text) throw new ToolError('type needs text')
          sendInput(turn.brandId, { type: 'text', text: args.text })
        } else {
          if (typeof args.key !== 'string') throw new ToolError('key needs key')
          sendInput(turn.brandId, { type: 'key', key: args.key as 'back' })
        }
      } catch (err) {
        if (err instanceof ToolError) throw err
        throw new ToolError(err instanceof Error ? err.message : String(err))
      }
      await new Promise((r) => setTimeout(r, 500))
      return 'done, take a phone_screenshot to see the screen now'
    }
  }
]
