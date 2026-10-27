import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PipelineStage } from '@shared/workspace'
import type { Run } from '@shared/pipeline'
import { Menu } from '../chat/ui'
import { CloseIcon } from '../components/Icons'
import StageStrip from './StageStrip'
import PipelineEditor from './PipelineEditor'
import Placeholder from './Placeholder'
import { toolWorkspaces, workspaceFor, type WorkspaceProps } from './registry'
import { PaneContext } from './pane'
import { craftKey } from './craft/apps'
import { useCraftApps } from './craft/store'

// what the right pane shows: a pipeline stage, a tool from the menu, or a site tab
export type WsView = { kind: 'stage'; stageId: string } | { kind: 'tool'; key: string } | { kind: 'site'; id: string }

export const MIN_WS = 360
export const MAX_WS = 1400

interface Props extends Omit<WorkspaceProps, 'stage' | 'onOpenWorkspace'> {
  view: WsView
  onView: (v: WsView) => void
  // moves the project to a stage
  onSetStage: (stageId: string) => void
  collapsed: boolean
  onCollapse: () => void
  width: number
  onWidth: (w: number) => void
  // the site strip and the kept alive site tabs. always rendered in the same spot,
  // a webview that moves in the dom reloads
  sites: ReactNode
  siteStrip: ReactNode
}

function Resizer({ width, onWidth }: Pick<Props, 'width' | 'onWidth'>): ReactNode {
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      className="ws-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace"
      title="Drag to resize, double click to reset"
      onDoubleClick={() => onWidth(Math.round(window.innerWidth * 0.42))}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const max = Math.min(MAX_WS, window.innerWidth - 560)
        onWidth(Math.max(MIN_WS, Math.min(max, start.current.w + start.current.x - e.clientX)))
      }}
      onPointerUp={() => {
        start.current = null
        document.body.classList.remove('resizing')
      }}
    />
  )
}

// the project's newest open run, kept current from run:changed
function useRun(brandId: string, projectId: string): Run | null {
  const [run, setRun] = useState<Run | null>(null)
  useEffect(() => {
    let alive = true
    const api = window.trenddeckPipeline
    const load = (): void => {
      void api.listRuns(brandId, { projectId, archived: false }).then((list) => alive && setRun(list[0] ?? null))
    }
    setRun(null)
    load()
    const offRun = api.onRunChanged((c) => {
      if (c.brandId !== brandId || c.run.projectId !== projectId) return
      if (c.removed || c.run.archived) load()
      else setRun((r) => (!r || r.id === c.run.id || c.run.updatedAt >= r.updatedAt ? c.run : r))
    })
    // stages changing moves runs along with them
    const offPipe = api.onChanged((c) => c.brandId === brandId && load())
    return () => {
      alive = false
      offRun()
      offPipe()
    }
  }, [brandId, projectId])
  return run
}

export default function WorkspacePane(props: Props): ReactNode {
  const { brand, project, view, onView, collapsed } = props
  const stages: PipelineStage[] = brand.pipeline
  const stage = view.kind === 'stage' ? (stages.find((s) => s.id === view.stageId) ?? null) : null
  const key = view.kind === 'stage' ? stage?.workspace : view.kind === 'tool' ? view.key : null
  const def = key ? workspaceFor(key) : undefined
  const View = def?.component
  const site = view.kind === 'site' ? brand.sites.find((s) => s.id === view.id) : undefined

  const crumb =
    view.kind === 'stage' ? (stage?.label ?? 'Stage') : view.kind === 'tool' ? (def?.label ?? 'Tool') : (site?.name ?? 'Site')
  const tools = toolWorkspaces()
  const craft = useCraftApps() ?? []
  const run = useRun(brand.id, project.id)
  const [editing, setEditing] = useState(false)
  const paneValue = useMemo(() => ({ collapsed }), [collapsed])
  const [runError, setRunError] = useState('')
  const here = run?.currentStageId ?? project.stageId

  const startRun = (): void => {
    setRunError('')
    void window.trenddeckPipeline
      .createRun(brand.id, { projectId: project.id, title: project.name })
      .catch((err: unknown) => setRunError(err instanceof Error ? err.message : String(err)))
  }

  // the project and its run move together
  const setStage = (stageId: string): void => {
    props.onSetStage(stageId)
    if (run) void window.trenddeckPipeline.updateRun(brand.id, run.id, { currentStageId: stageId })
  }

  return (
    <aside className={`ws${collapsed ? ' collapsed' : ''}`} style={{ width: props.width }} aria-label="Workspace" aria-hidden={collapsed}>
      <Resizer width={props.width} onWidth={props.onWidth} />
      <header className="ws-head">
        <span className="ws-crumb">
          <span className="muted">{view.kind === 'stage' ? 'Pipeline' : view.kind === 'tool' ? 'Tools' : 'Sites'}</span>
          <span className="ws-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span className="ws-crumb-here">{crumb}</span>
        </span>
        {stage && stage.id !== here && (
          <button className="ws-head-btn" title={`Move ${project.name} to ${stage.label}`} onClick={() => setStage(stage.id)}>
            Move here
          </button>
        )}
        <span className="spacer" />
        <Menu
          label="Tools"
          className="ws-tools"
          trigger={<span className="ws-head-btn">Tools</span>}
          items={[
            ...tools.map(([k, d]) => ({ label: d.label, onSelect: () => onView({ kind: 'tool', key: k }) })),
            ...(brand.sites[0] ? [{ label: 'Sites', onSelect: () => onView({ kind: 'site', id: brand.sites[0].id }) }] : []),
            // the Craft apps, opened on this project's files
            ...craft.map((c, i) => ({
              label: c.app.name,
              divider: i === 0,
              shortcut: c.running ? 'Open' : c.install.kind === 'installed' ? undefined : 'Install',
              onSelect: () => onView({ kind: 'tool', key: craftKey(c.app.id) })
            }))
          ]}
        />
        <button className="icon-btn small" title="Hide workspace (Ctrl+B)" aria-label="Hide workspace" onClick={props.onCollapse}>
          <CloseIcon />
        </button>
      </header>
      <StageStrip
        stages={stages}
        currentId={project.stageId}
        openId={stage?.id ?? null}
        onOpen={(id) => onView({ kind: 'stage', stageId: id })}
        run={run}
        onEdit={() => setEditing(true)}
        onStartRun={startRun}
      />
      {runError && <p className="cx-error ws-run-error">{runError}</p>}
      {view.kind === 'site' && props.siteStrip}
      <div className="ws-body">
        {view.kind !== 'site' &&
          (View ? (
            <Suspense fallback={<div className="page" />}>
              <PaneContext.Provider value={paneValue}>
              <View
                brand={brand}
                project={project}
                stage={stage}
                editBrand={props.editBrand}
                onEditBrand={props.onEditBrand}
                onOpenWorkspace={(k) => onView({ kind: 'tool', key: k })}
                onOpenUrl={props.onOpenUrl}
                trendQuery={props.trendQuery}
                onTrendQuery={props.onTrendQuery}
              />
              </PaneContext.Provider>
            </Suspense>
          ) : (
            <Placeholder title={crumb} text="Nothing to edit by hand here yet. The agent handles this step." />
          ))}
        <div className={`ws-sites${view.kind === 'site' ? ' on' : ''}`}>{props.sites}</div>
        {editing && <PipelineEditor brandId={brand.id} stages={stages} onClose={() => setEditing(false)} />}
      </div>
    </aside>
  )
}
