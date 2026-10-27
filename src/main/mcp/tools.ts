import { BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { isHttpUrl, type Brand, type Site } from '@shared/types'
import { getData } from '../store'
import { addLog, isGranted, loadState } from './state'
import type { Turn } from './turns'
import { authGuard, loginTool } from '../vault'
import { resolveForUpload } from '../media/upload'
import { ToolError, type GatewayTool } from '../gateway/types'
import { bool, int, list, obj, oneOf, str } from '../gateway/validate'
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

// the brand and its site tabs. everything here is checked against the sites the user let
// agents use, and nothing works on sign-in pages. the gateway adds risk, approval and audit

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

// agents never press a site's own post or send control, so every post goes past the user's post check
const PUBLISH_BLOCKED =
  "that's the site's own post, publish or send button and agents can't press it. use request_post instead: TrendDeck fills the post in on this site and the user checks it and presses Post themselves"

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

// agents only get files from the brand's media library the user allowed for agents.
// resolveForUpload is the one place an id turns into a path, the agent never sees it
export async function checkUpload(turn: Turn, id: string): Promise<string> {
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

// page text can carry anything a site puts on screen. the gateway's redaction runs on it after
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const SITE_TOOLS: GatewayTool[] = [
  {
    name: 'list_brands',
    title: 'Brand and its sites',
    description:
      "The brand this chat is for: its keywords and sites, and whether agents may use each site. Other brands are only counted, they stay private to their own chats.",
    inputSchema: obj(),
    risk: 'read',
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
    title: 'See the open tab',
    description: 'The site tab the user has open for the current brand: site, url and title. Url and title only show if agents may use that site.',
    inputSchema: obj(),
    risk: 'read',
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
    title: 'Read the open tab',
    description:
      'Read the open tab: url, title, headings, the visible text and a list of things you can click or type into, each with a [ref] number for click, type and upload_file. Refs change when the page changes, so read again after acting. Field values, passwords and cookies are never included.',
    inputSchema: obj({ max_text: int('max characters of page text, default 6000', 500, 15000) }),
    risk: 'read',
    annotations: { openWorldHint: true, idempotentHint: false },
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
    title: 'Click in the open tab',
    description: "Click an element in the open tab by its [ref] from read_page. A site's own post, publish or send button is refused, use request_post.",
    inputSchema: obj({ ref: int('ref number from read_page', 1) }, ['ref']),
    risk: 'edit',
    annotations: { openWorldHint: true },
    summarize: (_t, args) => `Click [${args.ref}] in the open tab`,
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const info = await locate(wc, Number(args.ref))
      if (!info.ok) throw new ToolError(info.error ?? 'not found')
      await wait(150)
      const again = await locate(wc, Number(args.ref))
      // checked on both reads, the page can move between them
      if (info.publish || again.publish) {
        await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'denied', detail: `post button [${args.ref}]` })
        throw new ToolError(PUBLISH_BLOCKED)
      }
      await click(wc, again.x ?? info.x!, again.y ?? info.y!)
      await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'click', detail: `${info.tag} [${args.ref}]` })
      await wait(600)
      await waitIdle(wc, 5000)
      return `clicked. now on ${wc.getURL()}`
    }
  },
  {
    name: 'type',
    title: 'Type in the open tab',
    description:
      'Type text into a text box in the open tab by its [ref]. clear replaces what is there, submit presses Enter after. Never works on password, card or code fields.',
    inputSchema: obj(
      {
        ref: int('ref number from read_page', 1),
        text: str('text to type', 20000, 1),
        clear: bool('replace the current text'),
        submit: bool('press Enter after typing')
      },
      ['ref', 'text']
    ),
    risk: 'edit',
    annotations: { openWorldHint: true },
    summarize: (_t, args) => `Type ${String(args.text).length} characters into [${args.ref}]${args.submit ? ' and press Enter' : ''}`,
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const body = String(args.text)
      const info = await locate(wc, Number(args.ref))
      if (!info.ok) throw new ToolError(info.error ?? 'not found')
      if (info.secret) throw new ToolError("agents can't type into password, card or code fields")
      if (!info.editable) throw new ToolError(`[${args.ref}] is a ${info.tag}, not a text box`)
      // Enter in a compose box or a form that posts would send it without the post check
      if (args.submit === true && (info.multiline || info.formPublishes)) {
        await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'denied', detail: `Enter in [${args.ref}]` })
        throw new ToolError(
          "submit would send this on the site and agents can't do that. type without submit, then use request_post for anything that should go out"
        )
      }
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
    title: 'Scroll the open tab',
    description: 'Scroll the open tab up or down by some screens (default 1).',
    inputSchema: obj(
      { direction: oneOf('up or down', ['up', 'down']), screens: { type: 'number', description: 'how many screens, default 1', minimum: 0.2, maximum: 10 } },
      ['direction']
    ),
    risk: 'read',
    annotations: { openWorldHint: true, idempotentHint: false },
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
      await wait(400)
      return 'scrolled, read_page to see what is there now'
    }
  },
  {
    name: 'upload_file',
    title: 'Put media into a file input',
    description:
      'Put files from the media library into a file input in the open tab by its [ref] (file inputs show in read_page even when hidden). Takes media ids from media_list, only files the user allowed for agents.',
    inputSchema: obj(
      { ref: int('ref of an input type=file', 1), media_ids: list('ids from media_list', str('media id', 100), 20, 1) },
      ['ref', 'media_ids']
    ),
    risk: 'edit',
    annotations: { openWorldHint: true },
    summarize: (_t, args) => `Put ${(args.media_ids as string[]).length} media file(s) into file input [${args.ref}]`,
    run: async (turn, args) => {
      const { wc, site } = await allowedTab(turn)
      const raw = args.media_ids as string[]
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
    title: 'Open a site tab',
    description:
      "Open one of the current brand's sites in its tab, by site id or name, optionally at a url on that site. The site has to be allowed.",
    inputSchema: obj({ site: str('site id or name from list_brands', 100, 1), url: str('optional url on that site', 2000) }, ['site']),
    risk: 'read',
    annotations: { openWorldHint: true, idempotentHint: false },
    run: async (turn, args) => {
      const brand = brandOf(turn)
      const site = findSite(brand, String(args.site))
      if (!site) throw new ToolError(`${brand.name} has no site called ${args.site}`)
      if (!(await access(turn, site))) {
        await addLog({ brandId: turn.brandId, siteId: site.id, kind: 'denied', detail: 'open site' })
        throw new ToolError(DENIED)
      }
      const url = (typeof args.url === 'string' && args.url) || site.url
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
    name: loginTool.name,
    title: 'Sign in with the saved login',
    description: loginTool.description,
    inputSchema: obj({ site: str('site id or name from list_brands', 100, 1) }, ['site']),
    risk: 'edit',
    annotations: { openWorldHint: true },
    summarize: (turn, args) => {
      const site = findSite(brandOf(turn), String(args.site))
      return `Sign in on ${site?.name ?? String(args.site)} with the saved login`
    },
    run: loginTool.run
  }
]
