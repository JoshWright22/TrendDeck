import type { ReactNode } from 'react'
import type { Page } from './ComingSoon'
import { groupOf, pageLabel } from './groups'

interface Props {
  page: Page
  onPage: (page: Page) => void
  count?: Partial<Record<Page, number>>
}

export default function GroupTabs({ page, onPage, count }: Props): ReactNode {
  const group = groupOf(page)
  return (
    <div className="group-tabs" role="tablist" aria-label={group.name}>
      {group.pages.map((p) => (
        <button
          key={p}
          role="tab"
          aria-selected={p === page}
          className={`group-tab${p === page ? ' active' : ''}`}
          onClick={() => onPage(p)}
        >
          {pageLabel(p)}
          {count?.[p] ? <span className="count">{count[p]}</span> : null}
        </button>
      ))}
    </div>
  )
}
