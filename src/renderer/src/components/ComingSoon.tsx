import type { ReactNode } from 'react'

export const PAGES = ['Trends', 'Ideas', 'Voice', 'Media', 'Schedule', 'Writer', 'Analytics', 'Posting', 'Inbox'] as const
export type Page = (typeof PAGES)[number]

const BLURBS: Record<Page, string> = {
  Trends: "What's picking up in this brand's niche, pulled from its keywords.",
  Ideas: 'Post and video ideas built from the trends you save.',
  Voice: 'What the chat knows about how this brand writes.',
  Media: 'Every video, image and file you post, in one place.',
  Schedule: 'A calendar of what goes out where and when.',
  Writer: 'Draft titles, captions and scripts for each site.',
  Analytics: 'How your posts did across every site, in one place.',
  Posting: 'Post to every site from one place.',
  Inbox: 'Comments from every site in one list.'
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
