import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { Project } from '@shared/workspace'
import { craftBelongsTo } from '@shared/craft'
import { CraftWorkspace } from '../workspace/craft/CraftWorkspace'
import { useCraftApps } from '../workspace/craft/store'
import { PaneContext } from '../workspace/pane'
import { Dropdown } from './ui'
import './craft-chat.css'

interface Props {
  brand: Brand
  project: Project
  onActivate?: () => void
}

export default function CraftChat({ brand, project, onActivate }: Props): ReactNode {
  const apps = useCraftApps()
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState(false)
  const previous = useRef(new Set<string>())
  const running = apps?.filter((status) => craftBelongsTo(status, brand.id, project.id)) ?? []

  useEffect(() => {
    const opened = running.find((status) => !previous.current.has(JSON.stringify([status.app.id, status.file])))
    previous.current = new Set(running.map((status) => JSON.stringify([status.app.id, status.file])))
    if (!opened) return
    setSelected(opened.app.id)
    setExpanded(true)
    onActivate?.()
  }, [apps, brand.id, project.id, onActivate])

  const choose = (appId: string): void => {
    setSelected(appId)
    setExpanded(Boolean(appId))
    if (appId) onActivate?.()
  }

  return (
    <section className={`craft-chat${expanded && selected ? ' is-expanded' : ''}`} aria-label="Craft editors in chat">
      <div className="craft-chat-tools">
        <Dropdown
          label="Open an editor"
          className="craft-chat-pick"
          value={selected}
          disabled={!apps}
          onChange={choose}
          options={[
            { value: '', label: apps ? 'Open an editor' : 'Loading editors' },
            ...(apps ?? []).map((status) => ({
              value: status.app.id,
              label: status.app.name,
              hint: status.install.kind === 'installed' ? undefined : 'Needs to be installed first'
            }))
          ]}
        />
        {running.filter((status) => status.app.id !== selected).map((status) => (
          <button key={status.app.id} className="ws-head-btn" onClick={() => choose(status.app.id)}>
            {status.app.name}
          </button>
        ))}
        <span className="spacer" />
        {selected && (
          <button className="ws-head-btn" aria-expanded={expanded} onClick={() => {
            if (!expanded) onActivate?.()
            setExpanded(!expanded)
          }}>
            {expanded ? 'Hide editor' : 'Show editor'}
          </button>
        )}
      </div>
      {expanded && selected && (
        <>
          <p className="craft-chat-hint">
            {project.name} / {apps?.find((status) => status.app.id === selected)?.app.agent
              ? 'Edit here manually, or ask your agent to work in the same editor.'
              : 'Manual editing here. This app does not expose agent tools.'}
          </p>
          <div className="craft-chat-surface" key={selected}>
            <PaneContext.Provider value={{ collapsed: false, dockPriority: 1 }}>
              <CraftWorkspace appId={selected} brand={brand} project={project} />
            </PaneContext.Provider>
          </div>
        </>
      )}
    </section>
  )
}
