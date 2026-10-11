import type { ReactNode } from 'react'
import type { Brand } from '@shared/types'
import BrandRail from './BrandRail'
import SiteTabs from './SiteTabs'
import Shield from './Shield'
import { PAGES, type Page } from './ComingSoon'
import {
  AnalyticsIcon,
  ChatIcon,
  EditIcon,
  IdeasIcon,
  ScheduleIcon,
  SettingsIcon,
  TrendsIcon,
  WriterIcon
} from './Icons'

export type View = { kind: 'page'; page: Page } | { kind: 'site'; id: string } | { kind: 'chat' }

const NAV_ICONS: Record<Page, () => ReactNode> = {
  Trends: TrendsIcon,
  Ideas: IdeasIcon,
  Schedule: ScheduleIcon,
  Writer: WriterIcon,
  Analytics: AnalyticsIcon
}

interface Props {
  brands: Brand[]
  brand: Brand | null
  view: View
  onView: (view: View) => void
  onSelectBrand: (id: string) => void
  onEditBrand: (id: string) => void
  onAddBrand: () => void
  onAddSite: () => void
  onRemoveSite: (id: string) => void
  onMoveSite: (fromId: string, toId: string) => void
  onSettings: () => void
  blocked: number
  onToggleAdblock: () => void
}

export default function Sidebar(props: Props): ReactNode {
  const { brands, brand, view } = props
  return (
    <aside className="sidebar">
      <BrandRail
        brands={brands}
        activeId={brand?.id ?? null}
        onSelect={props.onSelectBrand}
        onEdit={props.onEditBrand}
        onAdd={props.onAddBrand}
      />

      {brand && (
        <div className="brand-head">
          <h1 title={brand.name}>{brand.name}</h1>
          <Shield
            on={brand.adblock}
            count={props.blocked}
            label={`every ${brand.name} site`}
            onToggle={props.onToggleAdblock}
          />
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
        <button
          className={`side-item${view.kind === 'chat' ? ' active' : ''}`}
          aria-current={view.kind === 'chat' ? 'page' : undefined}
          onClick={() => props.onView({ kind: 'chat' })}
        >
          <ChatIcon />
          <span className="side-name">Chat</span>
        </button>
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
