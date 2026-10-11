import type { Page } from './ComingSoon'

// the sidebar shows one entry per group, its pages are tabs inside
export const GROUPS = [
  { name: 'Discover', pages: ['Trends', 'Analytics'] },
  { name: 'Plan', pages: ['Ideas', 'Schedule'] },
  { name: 'Create', pages: ['Writer', 'Shorts', 'Media', 'Voice'] },
  { name: 'Publish', pages: ['Posting', 'Inbox'] }
] as const satisfies readonly { name: string; pages: readonly Page[] }[]

export type Group = (typeof GROUPS)[number]

const LABELS: Partial<Record<Page, string>> = {
  Analytics: 'My stats',
  Voice: 'Brand voice',
  Posting: 'Queue'
}

export const pageLabel = (p: Page): string => LABELS[p] ?? p

export const groupOf = (p: Page): Group => GROUPS.find((g) => (g.pages as readonly Page[]).includes(p)) ?? GROUPS[0]
