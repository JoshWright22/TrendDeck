import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CraftAppStatus } from '@shared/craft'
import { craftBelongsTo } from '@shared/craft'
import type { WorkspaceProps } from '../registry'
import Placeholder from '../Placeholder'
import { usePane } from '../pane'
import { craftName } from './apps'
import { craftApi, errorText, putCraft, useCraftApp } from './store'
import { useDock } from './useDock'
import './craft.css'

// a Craft app in the workspace pane. not installed: what it is and Install. installed: the
// project's files for it. open: a box the app's own window is docked over, with a thin bar

const AGENT_TEXT: Record<CraftAppStatus['agent'], string> = {
  off: 'Agent not connected',
  headless: 'Agent connected, working in the background',
  bridge: 'Agent connected to this window',
  error: "Agent couldn't connect"
}

export const mb = (n: number): string => `${Math.round(n / 1e5) / 10} MB`

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function InstallProgress({ received, total }: { received: number; total: number }): ReactNode {
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0
  return (
    <div className="craft-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

function Install({ status }: { status: CraftAppStatus }): ReactNode {
  const [error, setError] = useState('')
  const i = status.install
  const install = (): void => {
    setError('')
    void craftApi()
      ?.install(status.app.id)
      .then(putCraft, (err: unknown) => setError(errorText(err)))
  }
  return (
    <div className="page craft craft-center">
      <div className="craft-card">
        <h2>{status.app.name}</h2>
        <p className="craft-blurb">{status.app.blurb}</p>
        {i.kind === 'installing' ? (
          <>
            <InstallProgress received={i.received} total={i.total} />
            <p className="craft-hint">
              Downloading {status.app.name} {i.version}
              {i.total > 0 && `, ${mb(i.received)} of ${mb(i.total)}`}
            </p>
          </>
        ) : (
          <>
            <button className="pill teal" onClick={install}>
              {i.kind === 'failed' ? 'Try again' : 'Install'}
            </button>
            <p className="craft-hint">
              From {status.app.repo} on GitHub{status.latest ? `, version ${status.latest}` : ''}. Free, checked before it runs.
            </p>
          </>
        )}
        {i.kind === 'failed' && <p className="craft-error">{i.error}</p>}
        {error && <p className="craft-error">{error}</p>}
      </div>
    </div>
  )
}

function Files({ status, brandId, projectId, projectName }: { status: CraftAppStatus; brandId: string; projectId: string; projectName: string }): ReactNode {
  const appId = status.app.id
  const [files, setFiles] = useState<{ name: string; modified: number }[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setFiles(null)
    void craftApi()
      ?.files(brandId, projectId, appId)
      .then(
        (f) => alive && setFiles(f),
        (err: unknown) => {
          if (!alive) return
          setFiles([])
          setError(errorText(err))
        }
      )
    return () => {
      alive = false
    }
    // a save in the app changes the list, onChanged comes with it
  }, [brandId, projectId, appId, status.running, status.file])

  const open = (file: string | null): void => {
    setError('')
    setOpening(file ?? '')
    void craftApi()
      ?.open({ appId, brandId, projectId, file })
      .then(putCraft, (err: unknown) => setError(errorText(err)))
      .finally(() => setOpening(null))
  }

  const version = status.install.kind === 'installed' ? status.install.version : ''
  return (
    <div className="page craft">
      <header className="craft-head">
        <div>
          <h2>{status.app.name}</h2>
          <p className="craft-blurb">{status.app.blurb}</p>
        </div>
        <span className="spacer" />
        <span className="craft-version">{version && `v${version}`}</span>
      </header>
      <div className="craft-files">
        <div className="craft-files-head">
          <span>Files in {projectName}</span>
          {files && files.length === 0 && (
            <button className="pill teal" disabled={opening !== null} onClick={() => open(null)}>
              {opening === '' ? 'Opening...' : 'New'}
            </button>
          )}
        </div>
        {files === null && <p className="craft-hint craft-pad">Looking in the project folder...</p>}
        {files?.length === 0 && (
          <p className="craft-hint craft-pad">
            No {status.app.name} files in this project yet. New makes one in the project folder and opens it here.
          </p>
        )}
        {files && files.length > 0 && (
          <ul className="craft-list">
            {files.map((f) => (
              <li key={f.name}>
                <span className="craft-file" title={f.name}>
                  {f.name}
                </span>
                <span className="craft-when">{ago(f.modified)}</span>
                <button className="ws-head-btn" disabled={opening !== null} onClick={() => open(f.name)}>
                  {opening === f.name ? 'Opening...' : 'Open'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="craft-error craft-pad">{error}</p>}
      </div>
    </div>
  )
}

function Docked({ status }: { status: CraftAppStatus }): ReactNode {
  const { collapsed, dockPriority } = usePane()
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useDock(status.app.id, box, !collapsed, dockPriority)
  return (
    <div className="page craft craft-docked">
      <div className="craft-bar">
        <span className="craft-bar-name">{status.app.name}</span>
        {status.file && (
          <>
            <span className="craft-bar-sep" aria-hidden="true">
              /
            </span>
            <span className="craft-bar-file" title={status.file}>
              {status.file}
            </span>
          </>
        )}
        <span className="spacer" />
        {error && <span className="craft-error">{error}</span>}
        <span className="craft-agent" title={AGENT_TEXT[status.agent]} aria-label={AGENT_TEXT[status.agent]}>
          <span className={`craft-dot ${status.agent}`} aria-hidden="true" />
          {status.agent === 'off' ? 'Agent off' : status.agent === 'error' ? 'Agent error' : 'Agent'}
        </span>
        <button
          className="ws-head-btn"
          title={`Close ${status.app.name}, it saves first`}
          onClick={() => {
            setError('')
            void craftApi()
              ?.close(status.app.id)
              .catch((err: unknown) => setError(errorText(err)))
          }}
        >
          Close
        </button>
      </div>
      {/* the app's window sits exactly over this box. what's here only shows while it's hidden */}
      <div className="craft-dock" ref={box}>
        <p>{status.app.name} is open in its own window here</p>
      </div>
    </div>
  )
}

export function CraftWorkspace({ appId, brand, project }: Pick<WorkspaceProps, 'brand' | 'project'> & { appId: string }): ReactNode {
  const status = useCraftApp(appId)
  if (!craftApi()) {
    return <Placeholder title={craftName(appId)} text="This copy of TrendDeck can't run the Craft apps yet. Update it from Settings, About." />
  }
  if (status === undefined) return <div className="page craft" />
  if (status === null) return <Placeholder title={craftName(appId)} text="TrendDeck doesn't know this Craft app." />
  if (craftBelongsTo(status, brand.id, project.id)) return <Docked status={status} />
  if (status.install.kind !== 'installed') return <Install status={status} />
  return <Files status={status} brandId={brand.id} projectId={project.id} projectName={project.name} />
}
