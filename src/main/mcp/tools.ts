import { app, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isHttpUrl, SOURCE_NAMES, TREND_SOURCES, type Brand, type Site, type TrendFeed } from '@shared/types'
import { getData } from '../store'
import { addLog, changeState, isGranted, loadState, logEntry } from './state'
import type { Turn } from './turns'
import { authGuard, loginTool } from '../vault'
import { listMedia } from '../media'
import { resolveForUpload } from '../media/upload'
import { queueAgentPost } from '../posting'
import { brandSettings } from '../posting/store'
import { PLATFORMS, type Platform } from '@shared/posting'
import {
  click,
  focusRef,
  locate,
  markRef,
  openTab,
  pressEnter,
  scrollPage,
  siteForUrl,
  snapshot,
  waitForTab,
  waitIdle
} from './tabs'

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (turn: Turn, args: Record<string, unknown>) => Promise<unknown>
}

class ToolError extends Error {}

const obj = (props: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false
})

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const num = (description: string): Record<string, unknown> => ({ type: 'number', description })

function text(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = args[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${key} is required`)
    return ''
  }
  if (typeof v !== 'string') throw new ToolError(`${key} should be a string`)
  return v.slice(0, max)
}

function brandOf(turn: Turn): Brand {
  const brand = getData()?.brands.find((b) => b.id === turn.brandId)
  if (!brand) throw new ToolError('this brand was deleted')
  return brand
}

async function access(turn: Turn, site: Site | null): Promise<boolean> {
  if (!site) return false
  return turn.sharedSiteId === site.id || (await isGranted(turn.brandId, site.id))
}

const DENIED =
  "the user hasn't let agents use this site. ask them to allow it in Settings > Agent access, or to share the tab with their next message"

// the open tab, only if the site it's on is allowed for this turn
async function allowedTab(turn: Turn): Promise<{ wc: WebContents; site: Site }> {
  const brand = brandOf(turn)
  const wc = openTab(turn.brandId)
  if (!wc) throw new ToolError(`no site is open for ${brand.name}. use open_site first`)
  const site = siteForUrl(brand, wc.getURL())
  if (!site || !(await access(turn, site))) {
    await addLog({ brandId: turn.brandId, siteId: site?.id ?? '', kind: 'denied', detail: 'open tab' })
    throw new ToolError(DENIED)
  }
  // sign-in pages give agents nothing but the status
  const guard = await authGuard(turn.brandId, wc)
  if (guard) throw new ToolError(guard)
  return { wc, site }
}

function findSite(brand: Brand, key: string): Site | null {
  const k = key.trim().toLowerCase()
  return brand.sites.find((s) => s.id === key || s.name.toLowerCase() === k) ?? null
}

async function trendFeed(brandId: string): Promise<TrendFeed | null> {
  try {
    return JSON.parse(await fs.readFile(join(app.getPath('userData'), 'trends', `${brandId}.json`), 'utf8'))
  } catch {
    return null
  }
}

// agents only get files from the brand's media library the user allowed for agents.
// resolveForUpload is the one place an id turns into a path, the agent never sees it
async function checkUpload(turn: Turn, id: string): Promise<string> {
  try {
    const file = await resolveForUpload(id, { forAgent: true, brandId: turn.brandId })
    return file.path
  } catch (err) {
    throw new ToolError(`${id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

export const TOOLS: Tool[] = [
  {
    name: 'list_brands',
    description:
      "The brand this chat is for: its keywords and sites, and whether agents may use each site. Other brands are only counted, they stay private to their own chats.",
    inputSchema: obj(),
    run: async (turn) => {
      const brand = brandOf(turn)
      const state = await loadState()
      const others = (getData()?.brands.length ?? 1) - 1
      return {
        current: {
          id: brand.id,
          name: brand.name,
          keywords: brand.keywords,
          subreddits: brand.subreddits,
          sites: brand.sites.map((s) => ({
            id: s.id,
            name: s.name,
            url: s.url,
            agentAccess:
              turn.sharedSiteId === s.id
                ? 'shared for this message'
                : state.grants[brand.id]?.includes(s.id)
                  ? 'allowed'
                  : 'not allowed'
          }))
        },
        otherBrands: others
      }
    }
  },
  {
    name: 'get_open_tab',
    description: 'The site tab the user has open for the current brand: site, url and title. Url and title only show if agents may use that site.',
    inputSchema: obj(),
    run: async (turn) => {
      const brand = brandOf(turn)
      const wc = openTab(turn.brandId)
      if (!wc) return { open: false, note: 'no site tab is open, the user is on a TrendDeck page' }
      const site = siteForUrl(brand, wc.getURL())
      const ok = await access(turn, site)
      if (!ok) return { open: true, site: site?.name ?? 'unknown site', allowed: false, note: DENIED }
      return { open: true, site: site?.name, siteId: site?.id, allowed: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() }
    }
  },
  {
    name: 'read_page',
    description:
      'Read the open tab: url, title, headings, the visible text and a list of things you can click or type into, each with a [ref] number for click, type and upload_file. Refs change when the page changes, so read again after acting.',
    inputSchema: obj({ max_text: num('max characters of page text, default 6000, up to 15000') }),
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      await waitIdle(wc)
      const snap = await snapshot(wc)
      const max = Math.min(15000, Math.max(500, Number(args.max_text) || 6000))
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'read', detail: new URL(snap.url).pathname.slice(0, 80) })
      return [
        `url: ${snap.url}`,
        `title: ${snap.title}`,
        `scroll: ${snap.scroll.y} of ${snap.scroll.height}, window ${snap.scroll.view}`,
        '',
        'headings:',
        ...snap.headings,
        '',
        'elements:',
        ...snap.elements,
        '',
        'text:',
        snap.text.slice(0, max)
      ].join('\n')
    }
  },
  {
    name: 'click',
    description: 'Click an element in the open tab by its [ref] from read_page.',
    inputSchema: obj({ ref: num('ref number from read_page') }, ['ref']),
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const info = await locate(wc, Number(args.ref))
      if (!info.ok) throw new ToolError(info.error ?? 'not found')
      await new Promise((r) => setTimeout(r, 150))
      const again = await locate(wc, Number(args.ref))
      await click(wc, again.x ?? info.x!, again.y ?? info.y!)
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'click', detail: `${info.tag} [${args.ref}]` })
      await new Promise((r) => setTimeout(r, 600))
      await waitIdle(wc, 5000)
      return `clicked. now on ${wc.getURL()}`
    }
  },
  {
    name: 'type',
    description:
      'Type text into a text box in the open tab by its [ref]. clear replaces what is there, submit presses Enter after. Never works on password or card fields.',
    inputSchema: obj(
      {
        ref: num('ref number from read_page'),
        text: str('text to type'),
        clear: { type: 'boolean', description: 'replace the current text' },
        submit: { type: 'boolean', description: 'press Enter after typing' }
      },
      ['ref', 'text']
    ),
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const body = text(args, 'text', 20000)
      const info = await locate(wc, Number(args.ref))
      if (!info.ok) throw new ToolError(info.error ?? 'not found')
      if (info.secret) throw new ToolError("agents can't type into password, card or code fields")
      if (!info.editable) throw new ToolError(`[${args.ref}] is a ${info.tag}, not a text box`)
      // a real click first so sites that wake their editor on click get it
      await click(wc, info.x!, info.y!)
      await focusRef(wc, Number(args.ref), args.clear === true)
      if (args.clear === true) wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      if (args.clear === true) wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      await wc.insertText(body)
      if (args.submit === true) pressEnter(wc)
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'type', detail: `${body.length} characters into [${args.ref}]${args.submit ? ', pressed Enter' : ''}` })
      return `typed ${body.length} characters`
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the open tab up or down by some screens (default 1).',
    inputSchema: obj(
      { direction: { type: 'string', enum: ['up', 'down'] }, screens: num('how many screens, default 1') },
      ['direction']
    ),
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const screens = Math.min(10, Math.max(0.2, Number(args.screens) || 1))
      const [w, h] = (await wc.executeJavaScriptInIsolatedWorld(1717, [{ code: '[innerWidth, innerHeight]' }])) as [number, number]
      const dy = (args.direction === 'up' ? -1 : 1) * screens * h * 0.85
      const before = await scrollPage(wc, 0)
      const after = await scrollPage(wc, dy)
      // feeds that scroll inside a box ignore window scrolling, a wheel over the middle gets them
      if (after.y === before.y) {
        wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: -dy })
      }
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'scroll', detail: String(args.direction) })
      await new Promise((r) => setTimeout(r, 400))
      return 'scrolled, read_page to see what is there now'
    }
  },
  {
    name: 'list_media',
    description:
      "Files in this brand's media library the user allowed for agents: id, name, type, size, length, tags and where each was posted. No paths. Use the ids with upload_file and request_post.",
    inputSchema: obj({ query: str('optional name or tag to search for') }),
    run: async (turn, args) => {
      const query = text(args, 'query', 200, false)
      return listMedia(turn.brandId, query ? { query } : {})
    }
  },
  {
    name: 'upload_file',
    description:
      'Put files from the media library into a file input in the open tab by its [ref] (file inputs show in read_page even when hidden). Takes media ids from list_media, only files the user allowed for agents.',
    inputSchema: obj(
      { ref: num('ref of an input type=file'), media_ids: { type: 'array', items: { type: 'string' }, description: 'ids from list_media' } },
      ['ref', 'media_ids']
    ),
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const raw = Array.isArray(args.media_ids) ? args.media_ids.filter((p): p is string => typeof p === 'string') : []
      if (raw.length === 0 || raw.length > 20) throw new ToolError('give 1 to 20 media ids from list_media')
      const files: string[] = []
      for (const id of raw) files.push(await checkUpload(turn, id))
      const mark = randomUUID()
      const isFile = await markRef(wc, Number(args.ref), mark)
      if (!isFile) {
        await markRef(wc, Number(args.ref), null)
        throw new ToolError(`[${args.ref}] isn't a file input. look for an input type=file in read_page`)
      }
      const dbg = wc.debugger
      const mine = !dbg.isAttached()
      try {
        if (mine) dbg.attach('1.3')
        const doc = (await dbg.sendCommand('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } }
        const found = (await dbg.sendCommand('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: `[data-td-upload="${mark}"]`
        })) as { nodeId: number }
        if (!found.nodeId) throw new ToolError('lost the file input, read the page again')
        await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files })
      } finally {
        if (mine && dbg.isAttached()) dbg.detach()
        await markRef(wc, Number(args.ref), null).catch(() => {})
      }
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'upload', detail: files.map((f) => f.split(/[\\/]/).pop()).join(', ') })
      return `added ${files.length} file${files.length === 1 ? '' : 's'}`
    }
  },
  {
    name: 'open_site',
    description:
      "Open one of the current brand's sites in its tab, by site id or name, optionally at a url on that site. The site has to be allowed.",
    inputSchema: obj({ site: str('site id or name from list_brands'), url: str('optional url on that site') }, ['site']),
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const site = findSite(brand, text(args, 'site', 100))
      if (!site) throw new ToolError(`${brand.name} has no site called ${args.site}`)
      if (!(await access(turn, site))) {
        await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'denied', detail: 'open site' })
        throw new ToolError(DENIED)
      }
      const url = text(args, 'url', 2000, false) || site.url
      if (!isHttpUrl(url) || siteForUrl(brand, url)?.id !== site.id) {
        throw new ToolError(`that url isn't on ${site.name}`)
      }
      if (getData()?.activeBrandId !== turn.brandId) {
        throw new ToolError(`the user switched to another brand, ask them to come back to ${brand.name}`)
      }
      const host = new URL(site.url).hostname.replace(/^www\./, '')
      const wc = openTab(turn.brandId)
      if (wc && siteForUrl(brand, wc.getURL())?.id === site.id) {
        await wc.loadURL(url).catch(() => {})
      } else {
        send('mcp:open-site', { brandId: brand.id, siteId: site.id, url })
      }
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'open', detail: new URL(url).pathname.slice(0, 80) })
      const tab = await waitForTab(turn.brandId, host)
      if (tab) await waitIdle(tab)
      return tab ? `opened ${site.name}, now on ${tab.getURL()}` : `asked the app to open ${site.name}, it hasn't loaded yet`
    }
  },
  {
    name: 'list_trends',
    description: "What's trending for the current brand, ranked by growth score 0-100. Optional source filter.",
    inputSchema: obj({
      source: { type: 'string', enum: [...TREND_SOURCES] },
      limit: num('max items, default 25')
    }),
    run: async (turn, args) => {
      const feed = await trendFeed(turn.brandId)
      if (!feed) return 'no trends fetched yet. the user can open the Trends page to load them'
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 25))
      const items = feed.items
        .filter((i) => !args.source || i.source === args.source)
        .slice(0, limit)
        .map((i) => ({ source: SOURCE_NAMES[i.source], title: i.title, url: i.url, detail: i.detail, score: i.score }))
      return { fetchedAt: new Date(feed.fetchedAt).toISOString(), items }
    }
  },
  {
    name: 'list_ideas',
    description: 'Ideas the user saved for the current brand.',
    inputSchema: obj(),
    run: async (turn) =>
      brandOf(turn).ideas.map((i) => ({ title: i.title, url: i.url, source: i.source, savedAt: new Date(i.savedAt).toISOString() }))
  },
  {
    name: 'save_idea',
    description: "Save an idea to the current brand's Ideas list.",
    inputSchema: obj({ title: str('the idea'), url: str('optional link it came from') }, ['title']),
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const title = text(args, 'title', 300)
      const url = text(args, 'url', 2000, false)
      if (url && !isHttpUrl(url)) throw new ToolError('url has to be http or https')
      if (brand.ideas.some((i) => i.title === title && i.url === url)) return 'already saved'
      send('mcp:idea', { brandId: brand.id, title, url })
      await addLog({ brandId: brand.id, siteId: '', kind: 'idea', detail: title.slice(0, 80) })
      return 'saved'
    }
  },
  {
    name: 'list_schedule',
    description: 'Posts waiting for the user to review or already handled for the current brand, with suggested times, plus saved drafts.',
    inputSchema: obj(),
    run: async (turn) => {
      const state = await loadState()
      const brand = brandOf(turn)
      const siteName = (id: string): string => brand.sites.find((s) => s.id === id)?.name ?? ''
      return {
        posts: state.posts
          .filter((p) => p.brandId === turn.brandId)
          .sort((a, b) => (a.when || a.createdAt) - (b.when || b.createdAt))
          .map((p) => ({
            id: p.id,
            platform: p.platform,
            site: siteName(p.siteId),
            title: p.title,
            when: p.when ? new Date(p.when).toISOString() : null,
            status: p.status
          })),
        drafts: state.drafts
          .filter((d) => d.brandId === turn.brandId)
          .map((d) => ({ id: d.id, platform: d.platform, title: d.title, createdAt: new Date(d.createdAt).toISOString() }))
      }
    }
  },
  {
    name: 'create_draft',
    description: 'Save a draft post for the current brand. Nothing gets posted.',
    inputSchema: obj(
      { platform: str('e.g. youtube, tiktok, x, instagram, reddit'), title: str('title or first line'), body: str('the post text, script or description') },
      ['platform', 'body']
    ),
    run: async (turn, args) => {
      const draft = {
        id: randomUUID(),
        brandId: turn.brandId,
        platform: text(args, 'platform', 40),
        title: text(args, 'title', 300, false),
        body: text(args, 'body', 20000),
        createdAt: Date.now()
      }
      await changeState((s) => {
        s.drafts.push(draft)
        s.log.push(logEntry({ brandId: turn.brandId, siteId: '', kind: 'draft', detail: `${draft.platform}: ${draft.title.slice(0, 60)}` }))
      })
      return { saved: true, id: draft.id }
    }
  },
  {
    name: 'request_post',
    description:
      "Post something for this brand. TrendDeck opens the site in the brand's own session, fills the post in and waits for the user to check it and press Post. It goes out only when they do, unless they turned that check off for this brand. Media comes from list_media ids.",
    inputSchema: obj(
      {
        platform: str('youtube, tiktok, instagram, x or reddit'),
        title: str('title, needed for youtube and reddit'),
        body: str('the post text, caption or description'),
        media_id: str('optional media id from list_media, needed for youtube, tiktok and instagram'),
        subreddit: str('reddit only, without r/'),
        when: str('optional time to post, ISO 8601. empty means now')
      },
      ['platform', 'body']
    ),
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const platform = text(args, 'platform', 40).toLowerCase() as Platform
      if (!PLATFORMS.includes(platform)) throw new ToolError(`platform should be one of ${PLATFORMS.join(', ')}`)
      const whenRaw = text(args, 'when', 40, false)
      const when = whenRaw ? Date.parse(whenRaw) : 0
      if (whenRaw && Number.isNaN(when)) throw new ToolError('when should be an ISO date like 2026-10-12T18:00:00Z')
      if (when && when < Date.now() - 60000) throw new ToolError('when is in the past')
      const mediaId = text(args, 'media_id', 100, false)
      // checked now so the agent hears about a file it can't use right away
      if (mediaId) await checkUpload(turn, mediaId)
      const post = await queueAgentPost({
        brandId: brand.id,
        platform,
        title: text(args, 'title', 300, false),
        body: text(args, 'body', 20000),
        mediaId,
        mediaUrl: '',
        subreddit: text(args, 'subreddit', 30, false),
        visibility: 'public',
        scheduledAt: when || null
      })
      await addLog({ brandId: brand.id, siteId: '', kind: 'post-request', detail: `${platform}: ${post.title.slice(0, 60)}` })
      const audit = !brandSettings(brand.id).autoPost
      return {
        queued: true,
        id: post.id,
        note: audit
          ? 'the user checks it in the site and presses Post themselves, see the Posting page for how it went'
          : 'this brand posts without a check, it goes out when its turn comes'
      }
    }
  },
  loginTool
]

export async function callTool(turn: Turn, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { content: [{ type: 'text', text: `no tool called ${name}` }], isError: true }
  try {
    const out = await tool.run(turn, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>)
    const body = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
    return { content: [{ type: 'text', text: body }] }
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `failed: ${err instanceof Error ? err.message : String(err)}`
    return { content: [{ type: 'text', text: msg }], isError: true }
  }
}
