import type { ReactNode } from 'react'
import type { Brand, Site } from '@shared/types'
import SiteTabs from './SiteTabs'
import { PAGES, type Page } from './ComingSoon'
import {
  AnalyticsIcon,
  EditIcon,
  IdeasIcon,
  ScheduleIcon,
  SettingsIcon,
  TrendsIcon,
  WriterIcon
} from './Icons'
import { MediaIcon } from '../pages/media/MediaIcons'

export type View = { kind: 'page'; page: Page } | { kind: 'site'; id: string }

const NAV_ICONS: Record<Page, () => ReactNode> = {
  Trends: TrendsIcon,
  Ideas: IdeasIcon,
  Media: MediaIcon,
  Schedule: ScheduleIcon,
  Writer: WriterIcon,
  Analytics: AnalyticsIcon
}

interface Props {
  brand: Brand | null
  view: View
  onView: (view: View) => void
  onEditBrand: (id: string) => void
  onAddSite: () => void
  temps: Site[]
  onRemoveSite: (id: string) => void
  onCloseTemp: (id: string) => void
  onKeepTemp: (id: string) => void
  onMoveSite: (fromId: string, toId: string) => void
  onSettings: () => void
}

export default function Sidebar(props: Props): ReactNode {
  const { brand, view } = props
  return (
    <aside className="sidebar">
      {brand && (
        <div className="brand-head">
          <h1 title={brand.name}>{brand.name}</h1>
          <button
            className="icon-btn small"
            title="Edit brand and keywords"
            aria-label="Edit brand"
            onClick={() => props.onEditBrand(brand.id)}
          >
            <EditIcon />
          </button>
        </div>
      )}

      <nav className="side-section" aria-label="Pages">
        {PAGES.map((p) => {
          const Icon = NAV_ICONS[p]
          const active = view.kind === 'page' && view.page === p
          return (
            <button
              key={p}
              className={`side-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => props.onView({ kind: 'page', page: p })}
            >
              <Icon />
              <span className="side-name">{p}</span>
              {p === 'Ideas' && brand && brand.ideas.length > 0 && (
                <span className="count">{brand.ideas.length}</span>
              )}
            </button>
          )
        })}
      </nav>

      {brand && (
        <SiteTabs
          sites={brand.sites}
          temps={props.temps}
          onCloseTemp={props.onCloseTemp}
          onKeepTemp={props.onKeepTemp}
          activeId={view.kind === 'site' ? view.id : null}
          onSelect={(id) => props.onView({ kind: 'site', id })}
          onRemove={props.onRemoveSite}
          onMove={props.onMoveSite}
          onAdd={props.onAddSite}
        />
      )}

      <button className="side-item settings-btn" onClick={props.onSettings}>
        <SettingsIcon />
        <span className="side-name">Settings</span>
      </button>
    </aside>
  )
}
