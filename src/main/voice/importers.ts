import { BrowserWindow, type Session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImportPlatform } from '@shared/voice'

export interface PagePost {
  text: string
  url: string
  postedAt: number | null
  views: number | null
  likes: number | null
}

const MAX_PER_PLATFORM = 60

// for testing: point this at a folder of saved pages (youtube.html, x.html...) and the
// importer reads those instead of the real sites
const SAMPLES = process.env.TRENDDECK_VOICE_SAMPLES ?? ''

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// helpers every page script gets. plain js, it runs inside the site's page
const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/(\\d+(?:\\.\\d+)?)\\s*([KMB])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(Number(m[1]) * mult);
};
const UNIT = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
const ago = (m) => Date.now() - Number(m[1]) * UNIT[m[2].toLowerCase()];
const textOf = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
`

// each one fills found (url -> post) from whatever is on the page right now
const EXTRACT: Record<ImportPlatform, string> = {
  youtube: `(found) => {
    for (const a of document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]')) {
      const url = a.href.split('&')[0];
      // thumbnail links have no text, the title link does
      const title = (a.getAttribute('title') || textOf(a)).trim();
      if (title.length < 2) continue;
      const prev = found.get(url);
      if (prev && prev.text.length >= title.length) continue;
      const box = a.closest('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer') || a.parentElement;
      const meta = textOf(box);
      const v = meta.match(/([\\d.,]+\\s*[KMB]?)\\s*views/i);
      const t = meta.match(/(\\d+)\\s*(second|minute|hour|day|week|month|year)s?\\s+ago/i);
      found.set(url, { text: title, url, views: v ? count(v[1]) : null, likes: null, postedAt: t ? ago(t) : null });
    }
  }`,
  tiktok: `(found) => {
    for (const it of document.querySelectorAll('[data-e2e="user-post-item"]')) {
      const a = it.querySelector('a[href*="/video/"], a[href*="/photo/"]');
      if (!a) continue;
      const url = a.href.split('?')[0];
      const img = it.querySelector('img[alt]');
      const text = (img ? img.alt : '').replace(/\\s+created by .+? with .+$/i, '').trim();
      if (!text) continue;
      // tiktok ids carry the post time in their top 32 bits
      const id = (url.match(/\\/(?:video|photo)\\/(\\d+)/) || [])[1];
      let postedAt = null;
      try { if (id) postedAt = Number(BigInt(id) >> 32n) * 1000; } catch {}
      const v = it.querySelector('[data-e2e="video-views"]');
      found.set(url, { text, url, views: v ? count(textOf(v)) : null, likes: null, postedAt });
    }
  }`,
  instagram: `(found) => {
    for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const url = a.href.split('?')[0];
      const img = a.querySelector('img[alt]');
      const alt = img ? img.alt.trim() : '';
      // alt text made up by instagram, not the caption
      if (!alt || /^(photo|video|reel)( shared)? by .+? on \\w+ \\d{1,2}, \\d{4}\\.? ?(may be|no photo description)/i.test(alt)) continue;
      const d = alt.match(/on (January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2}), (\\d{4})/);
      const postedAt = d ? Date.parse(d[1] + ' ' + d[2] + ', ' + d[3]) : null;
      const v = textOf(a).match(/^([\\d.,]+\\s*[KMB]?)$/im);
      found.set(url, { text: alt, url, views: v ? count(v[1]) : null, likes: null, postedAt });
    }
  }`,
  x: `(found) => {
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const ctx = art.querySelector('[data-testid="socialContext"]');
      if (ctx && /repost|retweet/i.test(textOf(ctx))) continue;
      const time = art.querySelector('time[datetime]');
      const link = time && time.closest('a');
      if (!link) continue;
      const url = link.href.split('?')[0];
      if (HANDLE && !url.toLowerCase().includes('/' + HANDLE.toLowerCase() + '/status/')) continue;
      const text = textOf(art.querySelector('[data-testid="tweetText"]'));
      if (!text) continue;
      const like = art.querySelector('[data-testid="like"], [data-testid="unlike"]');
      const views = art.querySelector('a[href$="/analytics"]');
      found.set(url, {
        text, url,
        postedAt: Date.parse(time.getAttribute('datetime')) || null,
        likes: like ? count(like.getAttribute('aria-label') || textOf(like)) : null,
        views: views ? count(views.getAttribute('aria-label') || textOf(views)) : null
      });
    }
  }`,
  reddit: `(found) => {
    for (const p of document.querySelectorAll('shreddit-post')) {
      const author = p.getAttribute('author') || '';
      if (HANDLE && author && author.toLowerCase() !== HANDLE.toLowerCase()) continue;
      const title = (p.getAttribute('post-title') || '').trim();
      if (!title) continue;
      const link = p.getAttribute('permalink') || '';
      const url = link.startsWith('http') ? link : 'https://www.reddit.com' + link;
      const body = textOf(p.querySelector('[slot="text-body"]'));
      const sub = p.getAttribute('subreddit-prefixed-name');
      found.set(url, {
        text: (sub ? sub + ': ' : '') + title + (body ? '\\n\\n' + body : ''),
        url,
        postedAt: Date.parse(p.getAttribute('created-timestamp') || '') || null,
        likes: count(p.getAttribute('score')),
        views: null
      });
    }
  }`
}

function pageScript(platform: ImportPlatform, handle: string, rounds: number, wait: number): string {
  return `(async () => {
    ${HELPERS}
    const HANDLE = ${JSON.stringify(handle)};
    const extract = ${EXTRACT[platform]};
    const found = new Map();
    for (let i = 0; i < ${rounds}; i++) {
      extract(found);
      if (found.size >= ${MAX_PER_PLATFORM}) break;
      window.scrollBy(0, window.innerHeight * 2);
      await sleep(${wait});
    }
    return [...found.values()].slice(0, ${MAX_PER_PLATFORM});
  })()`
}

function profileUrls(platform: ImportPlatform, handle: string): string[] {
  const h = encodeURIComponent(handle)
  switch (platform) {
    case 'youtube':
      return [`https://www.youtube.com/@${h}/videos`, `https://www.youtube.com/@${h}/shorts`]
    case 'tiktok':
      return [`https://www.tiktok.com/@${h}`]
    case 'instagram':
      return [`https://www.instagram.com/${h}/`]
    case 'x':
      return [`https://x.com/${h}`]
    case 'reddit':
      return [`https://www.reddit.com/user/${h}/submitted/`]
  }
}

const LOGIN_RE = /\/(login|signin|sign_in|accounts\/login|i\/flow\/login|ServiceLogin)\b/i

// a hidden window on the brand's own session, thrown away after
async function withPage<T>(ses: Session, url: string, settle: number, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([win.loadURL(url).catch(() => {}), sleep(20000)])
    await sleep(settle)
    if (!SAMPLES && LOGIN_RE.test(win.webContents.getURL())) throw new Error('not logged in on this brand')
    return await fn(win)
  } finally {
    win.destroy()
  }
}

async function runScript<T>(win: BrowserWindow, script: string, ms: number): Promise<T> {
  return Promise.race([
    win.webContents.executeJavaScript(script, true) as Promise<T>,
    sleep(ms).then(() => {
      throw new Error('the page took too long')
    })
  ])
}

// find the brand's own handle from the logged in session when the profile doesn't have one
async function discover(platform: ImportPlatform, ses: Session): Promise<string> {
  if (platform === 'reddit') {
    try {
      const res = await ses.fetch('https://www.reddit.com/api/me.json')
      const json = (await res.json()) as { data?: { name?: string } }
      if (json.data?.name) return json.data.name
    } catch {
      // falls through to the error below
    }
  }
  if (platform === 'x') {
    const href = await withPage(ses, 'https://x.com/home', 3000, (win) =>
      runScript<string | null>(
        win,
        `(document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') || {}).getAttribute?.('href') || null`,
        5000
      )
    )
    if (href) return href.replace(/^\//, '')
  }
  throw new Error('add your handle for this site in the profile first')
}

export async function readOwnPosts(
  platform: ImportPlatform,
  ses: Session,
  handle: string
): Promise<PagePost[]> {
  let urls: string[]
  if (SAMPLES) {
    urls = [pathToFileURL(join(SAMPLES, `${platform}.html`)).href]
  } else {
    if (!handle) handle = await discover(platform, ses)
    urls = profileUrls(platform, handle)
  }
  const out: PagePost[] = []
  const rounds = SAMPLES ? 1 : 5
  for (const url of urls) {
    const posts = await withPage(ses, url, SAMPLES ? 300 : 3500, (win) =>
      runScript<PagePost[]>(win, pageScript(platform, handle, rounds, 1500), 30000)
    )
    out.push(...(Array.isArray(posts) ? posts : []))
  }
  return out
}
