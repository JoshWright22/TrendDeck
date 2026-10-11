import type { InboxSite } from '@shared/inbox'

// where each site lists the comments people leave on your posts, and a page script that reads them.
// one entry per site so when a site changes its page this is the only thing to fix
export interface Reader {
  url: string
  // youtube studio needs the channel id from the redirect, so it gets a second hop
  then?: (landed: string) => string | null
  script: string
}

export interface RawComment {
  id: string
  author: string
  authorUrl: string
  text: string
  url: string
  postTitle: string
  at: number
}

// shared helpers that run inside the page
const HELPERS = `
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const abs = (href) => { try { return new URL(href, location.href).href } catch { return '' } };
  const when = (el) => {
    if (!el) return 0;
    const v = el.getAttribute('datetime') || el.getAttribute('title') || '';
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  };
  const all = (root, sel) => Array.from(root.querySelectorAll(sel));
`

export const READERS: Record<InboxSite, Reader> = {
  youtube: {
    url: 'https://studio.youtube.com/',
    then: (landed) => {
      const m = /studio\.youtube\.com\/channel\/(UC[\w-]+)/.exec(landed)
      return m ? `https://studio.youtube.com/channel/${m[1]}/comments/inbox` : null
    },
    script: `(() => { ${HELPERS}
      return all(document, 'ytcp-comment-thread, ytcp-comment').map((el) => {
        const a = el.querySelector('#name a, a#name, .author a, a[href*="/channel/"]');
        const body = el.querySelector('#content-text, .comment-text, yt-formatted-string#content-text');
        const video = el.querySelector('.video-title, #video-title, a[href*="/video/"]');
        const id = el.getAttribute('comment-id') || el.getAttribute('data-comment-id') || '';
        return { id, author: txt(a), authorUrl: a ? abs(a.getAttribute('href')) : '', text: txt(body),
          url: video ? abs(video.getAttribute('href')) : location.href, postTitle: txt(video),
          at: when(el.querySelector('time, .published-time-text')) };
      });
    })()`
  },
  instagram: {
    url: 'https://www.instagram.com/notifications/',
    script: `(() => { ${HELPERS}
      return all(document, '[data-inbox-row], div[role="button"], li').filter((el) => /comment/i.test(txt(el)) && el.querySelector('a[href^="/"]')).map((el) => {
        const a = el.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])');
        const post = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
        const author = a ? (a.getAttribute('href') || '').split('/').filter(Boolean)[0] || txt(a) : '';
        // drop the links so the name and post label don't end up in the text
        const copy = el.cloneNode(true);
        all(copy, 'a, time').forEach((n) => n.remove());
        const raw = txt(copy);
        const m = /commented:\\s*(.*)/i.exec(raw);
        return { id: '', author, authorUrl: a ? abs(a.getAttribute('href')) : '', text: m ? m[1] : raw,
          url: post ? abs(post.getAttribute('href')) : location.href, postTitle: '', at: when(el.querySelector('time')) };
      });
    })()`
  },
  tiktok: {
    url: 'https://www.tiktok.com/tiktokstudio/comment',
    script: `(() => { ${HELPERS}
      return all(document, '[data-e2e="comment-item"], [class*="CommentItem"], [data-tt="comment-item"]').map((el) => {
        const a = el.querySelector('a[href*="/@"]');
        const body = el.querySelector('[data-e2e="comment-text"], [class*="CommentText"], p');
        const post = el.querySelector('a[href*="/video/"]');
        const author = a ? ((a.getAttribute('href') || '').match(/@([\\w.]+)/) || [])[1] || txt(a) : '';
        return { id: el.getAttribute('data-id') || '', author, authorUrl: a ? abs(a.getAttribute('href')) : '',
          text: txt(body), url: post ? abs(post.getAttribute('href')) : location.href,
          postTitle: post ? txt(post) : '', at: when(el.querySelector('time')) };
      });
    })()`
  },
  x: {
    url: 'https://x.com/notifications/mentions',
    script: `(() => { ${HELPERS}
      return all(document, 'article[data-testid="tweet"]').map((el) => {
        const user = el.querySelector('[data-testid="User-Name"] a[href^="/"]');
        const time = el.querySelector('time');
        const link = time ? time.closest('a') : null;
        const href = link ? link.getAttribute('href') || '' : '';
        const m = /status\\/(\\d+)/.exec(href);
        return { id: m ? m[1] : '', author: user ? (user.getAttribute('href') || '').replace(/^\\//, '') : '',
          authorUrl: user ? abs(user.getAttribute('href')) : '', text: txt(el.querySelector('[data-testid="tweetText"]')),
          url: href ? abs(href) : '', postTitle: '', at: when(time) };
      });
    })()`
  },
  reddit: {
    // the old inbox is plain html and lists only replies to your posts and comments
    url: 'https://old.reddit.com/message/comments/',
    script: `(() => { ${HELPERS}
      return all(document, '.message.comment-reply, .message.post-reply, div.thing.message').map((el) => {
        const a = el.querySelector('a.author');
        const subject = el.querySelector('.subject a.title, .subject');
        const ctx = el.querySelector('a.bylink[data-event-action="context"], a[data-event-action="context"], .bylink');
        return { id: el.getAttribute('data-fullname') || '', author: txt(a), authorUrl: a ? abs(a.getAttribute('href')) : '',
          text: txt(el.querySelector('.md')), url: ctx ? abs(ctx.getAttribute('href')) : location.href,
          postTitle: txt(subject), at: when(el.querySelector('time')) };
      });
    })()`
  }
}

// a stable id when the site doesn't give one
export function hashId(parts: string[]): string {
  let h = 5381
  for (const ch of parts.join('|')) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

export function cleanRaw(list: unknown): RawComment[] {
  if (!Array.isArray(list)) return []
  const out: RawComment[] = []
  const seen = new Set<string>()
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
    const c: RawComment = {
      id: s(r.id, 200),
      author: s(r.author, 200),
      authorUrl: s(r.authorUrl, 1000),
      text: s(r.text, 4000),
      url: s(r.url, 2000),
      postTitle: s(r.postTitle, 500),
      at: typeof r.at === 'number' ? r.at : 0
    }
    if (!c.author || !c.text) continue
    if (!c.id) c.id = hashId([c.author, c.text, c.url])
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  return out
}

// reply boxes, tried in order. the box gets focused and the text typed in, you press the site's reply button
export const REPLY_STEPS: Record<InboxSite, { open: string[]; box: string[] }> = {
  youtube: {
    open: ['#reply-button button', 'ytcp-comment-button#reply-button', 'button[aria-label="Reply"]'],
    box: ['#contenteditable-root', 'textarea#textarea', '[contenteditable="true"]']
  },
  instagram: {
    open: ['div[role="button"]:has(> span:only-child)'],
    box: ['textarea[aria-label*="comment" i]', 'form textarea']
  },
  tiktok: {
    open: ['[data-e2e="comment-reply-1"]', 'span[data-e2e*="reply"]'],
    box: ['[data-e2e="comment-input"] [contenteditable="true"]', 'div[contenteditable="true"]']
  },
  x: {
    open: [],
    box: ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]']
  },
  reddit: {
    open: [],
    box: ['shreddit-composer [contenteditable="true"]', 'textarea[name="text"]', 'div[contenteditable="true"]']
  }
}
