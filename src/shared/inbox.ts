// account health and the comment inbox, shared by main, preload and the page

export type Health = 'in' | 'out' | 'unknown'

export interface SiteHealth {
  siteId: string
  host: string
  state: Health
  checkedAt: number
}

export type InboxSite = 'youtube' | 'instagram' | 'tiktok' | 'x' | 'reddit'
export const INBOX_SITES: InboxSite[] = ['youtube', 'instagram', 'tiktok', 'x', 'reddit']

export interface InboxComment {
  // site + the site's own id, or a hash of author and text when there isn't one
  id: string
  site: InboxSite
  // the brand's own account the comment came in on
  account: string
  author: string
  // profile link, used for the block button
  authorUrl: string
  text: string
  // link to the comment or the post it's on
  url: string
  postTitle: string
  at: number
  read: boolean
}

export interface BrandInbox {
  health: Record<string, SiteHealth>
  comments: InboxComment[]
  // site:author, hidden everywhere in the inbox
  blocked: string[]
  keywords: string[]
  refreshedAt: number
}

export interface RefreshResult {
  site: InboxSite
  ok: boolean
  count: number
  message: string
}

export interface InboxApi {
  load(brandId: string): Promise<BrandInbox>
  onUpdate(fn: (brandId: string, inbox: BrandInbox) => void): () => void
  checkHealth(brandId: string): Promise<BrandInbox>
  refresh(brandId: string): Promise<RefreshResult[]>
  markRead(brandId: string, ids: string[], read: boolean): Promise<void>
  setBlocked(brandId: string, blocked: string[]): Promise<void>
  setKeywords(brandId: string, keywords: string[]): Promise<void>
  // opens a window on the brand's session at the comment with the reply typed in, you press Reply
  reply(brandId: string, commentId: string, text: string): Promise<{ ok: boolean; message: string }>
  // opens the commenter's profile in a window on the brand's session so you can use the site's block or report
  openBlock(brandId: string, commentId: string): Promise<void>
}

export function blockKey(c: Pick<InboxComment, 'site' | 'author'>): string {
  return `${c.site}:${c.author.toLowerCase()}`
}

export function inboxSiteOf(host: string): InboxSite | null {
  if (host.endsWith('youtube.com')) return 'youtube'
  if (host.endsWith('instagram.com')) return 'instagram'
  if (host.endsWith('tiktok.com')) return 'tiktok'
  if (host === 'x.com' || host.endsWith('.x.com') || host.endsWith('twitter.com')) return 'x'
  if (host.endsWith('reddit.com')) return 'reddit'
  return null
}

declare global {
  interface Window {
    trenddeckInbox: InboxApi
  }
}
