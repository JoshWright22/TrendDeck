import type { ReactNode } from 'react'

export const PAGES = ['Trends', 'Ideas', 'Schedule', 'Writer', 'Analytics'] as const
export type Page = (typeof PAGES)[number]

const BLURBS: Record<Page, string> = {
  Trends: "What's picking up in this brand's niche, pulled from its keywords.",
  Ideas: 'Post and video ideas built from the trends you save.',
  Schedule: 'A calendar of what goes out where and when.',
  Writer: 'Draft titles, captions and scripts for each site.',
  Analytics: 'How your posts did across every site, in one place.'
}

export default function ComingSoon({ page }: { page: Page }): ReactNode {
  return (
    <div className="coming-soon">
      <div className="coming-soon-card">
        <span className="badge">Coming soon</span>
        <h2>{page}</h2>
        <p>{BLURBS[page]}</p>
      </div>
    </div>
  )
}
