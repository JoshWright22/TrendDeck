import { useRef, type ReactNode } from 'react'
import type { Brand, Site } from '@shared/types'
import SiteTabs from './SiteTabs'
import PhoneTab from '../emulator/PhoneTab'
import type { Page } from './ComingSoon'
import { GROUPS, groupOf, type Group } from './groups'
import { ChatIcon, EditIcon, IdeasIcon, SettingsIcon, TrendsIcon, WriterIcon } from './Icons'
import { PostingIcon } from '../posting/bits'
import { useInbox } from '../pages/inbox/useInbox'

export type View =
  | { kind: 'page'; page: Page }
  | { kind: 'site'; id: string }
  | { kind: 'settings' }
  | { kind: 'chat' }
  | { kind: 'phone' }

const GROUP_ICONS: Record<Group['name'], () => ReactNode> = {
  Discover: TrendsIcon,
  Plan: IdeasIcon,
  Create: WriterIcon,
  Publish: PostingIcon
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
  const inbox = useInbox(brand?.id)
  // a group opens on the tab you last had open in it
  const last = useRef<Partial<Record<Group['name'], Page>>>({})
  const group = view.kind === 'page' ? groupOf(view.page) : null
  if (group && view.kind === 'page') last.current[group.name] = view.page
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
        <button
          className={`side-item${view.kind === 'chat' ? ' active' : ''}`}
          aria-current={view.kind === 'chat' ? 'page' : undefined}
          onClick={() => props.onView({ kind: 'chat' })}
        >
          <ChatIcon />
          <span className="side-name">Chat</span>
        </button>
        {GROUPS.map((g) => {
          const Icon = GROUP_ICONS[g.name]
          const active = group?.name === g.name
          return (
            <button
              key={g.name}
              className={`side-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => props.onView({ kind: 'page', page: last.current[g.name] ?? g.pages[0] })}
            >
              <Icon />
              <span className="side-name">{g.name}</span>
            </button>
          )
        })}
      </nav>

      {/* the chat puts its list of chats here while it's open */}
      {view.kind === 'chat' && <div id="side-threads" className="side-threads" />}

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
          health={inbox?.health}
        />
      )}

      {brand && <PhoneTab active={view.kind === 'phone'} onClick={() => props.onView({ kind: 'phone' })} />}

      <button
        className={`side-item settings-btn${view.kind === 'settings' ? ' active' : ''}`}
        aria-current={view.kind === 'settings' ? 'page' : undefined}
        onClick={props.onSettings}
      >
        <SettingsIcon />
        <span className="side-name">Settings</span>
      </button>
    </aside>
  )
}
