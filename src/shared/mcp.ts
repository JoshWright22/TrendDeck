// agent access: which sites agents may touch, what they did, and what they left for review

export type AccessKind =
  | 'grant'
  | 'revoke'
  | 'share-once'
  | 'read'
  | 'click'
  | 'type'
  | 'scroll'
  | 'upload'
  | 'open'
  | 'denied'
  | 'idea'
  | 'draft'
  | 'post-request'
  | 'login'

export interface AccessLogEntry {
  id: string
  at: number
  brandId: string
  siteId: string
  kind: AccessKind
  // short and plain, never page content or what was typed
  detail: string
}

export interface AgentDraft {
  id: string
  brandId: string
  platform: string
  title: string
  body: string
  createdAt: number
}

export interface PostRequest {
  id: string
  brandId: string
  // the site it should go out on, empty if the agent didn't say
  siteId: string
  platform: string
  title: string
  body: string
  // when the agent suggests it goes out, 0 for no time
  when: number
  createdAt: number
  status: 'waiting' | 'done' | 'dismissed'
}

export interface McpState {
  // brand id to the site ids agents may use
  grants: Record<string, string[]>
  log: AccessLogEntry[]
  drafts: AgentDraft[]
  posts: PostRequest[]
}

export interface McpBrandSites {
  id: string
  name: string
  sites: { id: string; name: string; url: string }[]
}

export interface McpApi {
  getState(): Promise<McpState & { brands: McpBrandSites[] }>
  setGrant(brandId: string, siteId: string, on: boolean): Promise<void>
  clearLog(brandId: string): Promise<void>
  setPostStatus(id: string, status: PostRequest['status']): Promise<void>
  // the tab on screen goes to agents with the next chat message only
  shareTabOnce(brandId: string, siteId: string): Promise<void>
  sharedTab(): Promise<{ brandId: string; siteId: string } | null>
  onChanged(fn: () => void): () => void
  // agents ask the ui to show a site, main fills in the url
  onOpenSite(fn: (req: { brandId: string; siteId: string; url: string }) => void): () => void
  // ideas saved by an agent, the ui adds them so its copy of the data stays the one saved
  onIdea(fn: (req: { brandId: string; title: string; url: string }) => void): () => void
}
