import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ObsLive, ObsTake } from '@shared/obs'
import type { Brand } from '@shared/types'
import { Dropdown } from '../../chat/ui'
import type { WorkspaceProps } from '../registry'
import './obs.css'

// OBS in the chat card and in the right pane: connection in words, a small live preview while it's
// on screen, the scene, Record and Stop, and recent takes. main does the work and the checks

const clean = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

// the fix for a connection problem, in one line
function notConnected(error: string): string {
  if (/password/i.test(error)) return 'Not connected. Import the OBS password in Settings, OBS.'
  if (/cannot connect|timed out|disconnected|code 1006/i.test(error) || !error) {
    return 'Not connected. Open OBS and turn on its WebSocket server in Tools, WebSocket Server Settings.'
  }
  if (/identification|4009|authentication/i.test(error)) return 'Not connected. The OBS password changed, import it again in Settings, OBS.'
  return `Not connected. ${error}`
}

export function timecode(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const size = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const when = (at: number): string => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// true while the element is on screen and the app isn't hidden
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { threshold: 0.05 })
    io.observe(el)
    const vis = (): void => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', vis)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', vis)
    }
  }, [ref])
  return inView && pageVisible
}

// the live state while on screen. watching keeps main's monitor connection up
function useObsLive(brandId: string, onScreen: boolean): ObsLive | null {
  const [live, setLive] = useState<ObsLive | null>(null)
  useEffect(() => {
    if (!onScreen) return
    const api = window.trenddeckObs
    let alive = true
    const off = api.onLive((l) => l.brandId === brandId && alive && setLive(l))
    void api.watch(brandId).then((l) => alive && setLive(l)).catch(() => {})
    return () => {
      alive = false
      off()
      void api.unwatch(brandId).catch(() => {})
    }
  }, [brandId, onScreen])
  return live
}

// about 4 frames a second, one at a time, only while on screen and connected
function usePreview(brandId: string, run: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(null)
  useEffect(() => {
    if (!run) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      const started = Date.now()
      const next = await window.trenddeckObs.screenshot(brandId).catch(() => null)
      if (!alive) return
      if (next) setFrame(next)
      timer = setTimeout(() => void tick(), Math.max(0, 250 - (Date.now() - started)))
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [brandId, run])
  return frame
}

function useNow(run: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!run) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [run])
  return now
}

interface PanelProps {
  brand: Brand
  projectId: string | null
  // the chat a take goes to, null for the project's newest chat
  threadId: string | null
}

export function ObsPanel({ brand, projectId, threadId }: PanelProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(root)
  const live = useObsLive(brand.id, onScreen)
  const connected = !!live?.connected
  const frame = usePreview(brand.id, onScreen && connected)
  const ours = !!live?.ours && live.projectId === projectId
  const now = useNow(!!live?.recording)
  const [takes, setTakes] = useState<ObsTake[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const project = brand.projects.find((p) => p.id === projectId)

  const loadTakes = useCallback(() => {
    if (!projectId) return
    void window.trenddeckObs.takes(brand.id, projectId).then(setTakes).catch(() => setTakes([]))
  }, [brand.id, projectId])

  useEffect(() => {
    if (onScreen) loadTakes()
  }, [onScreen, loadTakes])

  // a recording of ours just ended, its file shows up in the list
  const wasOurs = useRef(false)
  useEffect(() => {
    if (wasOurs.current && !ours) {
      const t = setTimeout(loadTakes, 1500)
      wasOurs.current = ours
      return () => clearTimeout(t)
    }
    wasOurs.current = ours
  }, [ours, loadTakes])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const record = (): Promise<void> => act(() => window.trenddeckObs.startRecording(brand.id, projectId!, threadId))
  const stop = (): Promise<void> => act(() => window.trenddeckObs.stopRecording(brand.id, projectId!))
  const pickScene = (scene: string): Promise<void> => act(() => window.trenddeckObs.switchScene(brand.id, scene))
  const showTake = (t: ObsTake): Promise<void> =>
    act(async () => {
      if (!window.trenddeckTakes) throw new Error('Takes are not ready in this version yet.')
      await window.trenddeckTakes.fromFile(brand.id, threadId, projectId!, t.file)
      setShown(t.file)
    })

  const elapsed = live ? live.recordMs + (now - live.at) : 0
  let state: ReactNode
  if (!live) state = <span>Connecting to OBS</span>
  else if (!connected) state = <span>{notConnected(live.error)}</span>
  else if (ours && live.uncertain) state = <span>Waiting for OBS to answer</span>
  else if (ours && live.recording) {
    state = (
      <span className="obs-rec">
        <span className="obs-rec-dot" aria-hidden="true" />
        Recording <span className="obs-time">{timecode(elapsed)}</span>
      </span>
    )
  } else if (live.recording) state = <span>OBS is recording on its own. Stop it in OBS to record here.</span>
  else if (live.streaming) state = <span>Connected, OBS is live</span>
  else state = <span>Connected</span>

  return (
    <div className="obs-panel" ref={root}>
      <p className="obs-state" role="status">{state}</p>
      {connected && (
        <div className="obs-preview">
          {frame ? <img src={frame} alt={`OBS preview of ${live?.currentScene ?? 'the program scene'}`} /> : <span className="obs-preview-empty">No picture yet</span>}
        </div>
      )}
      {connected && (
        <div className="obs-controls">
          {live!.scenes.length > 0 && (
            <Dropdown
              label="Scene"
              title="OBS scene"
              value={live!.currentScene ?? ''}
              options={live!.scenes.map((s) => ({ value: s, label: s }))}
              disabled={busy}
              onChange={(s) => void pickScene(s)}
            />
          )}
          <span className="obs-spacer" />
          {ours ? (
            <button type="button" className="obs-btn primary" disabled={busy || live!.uncertain} onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="obs-btn primary"
              disabled={busy || !projectId || live!.recording || live!.ours}
              title={projectId ? `Record ${project?.name ?? 'this project'} in OBS` : 'This chat has no project'}
              onClick={() => void record()}
            >
              Record
            </button>
          )}
        </div>
      )}
      {live?.note && <p className="obs-note">{live.note}</p>}
      {error && (
        <p className="obs-error" role="alert">
          {error}
        </p>
      )}
      {projectId && takes.length > 0 && (
        <ul className="obs-takes" aria-label="Recent takes">
          {takes.slice(0, 5).map((t) => (
            <li key={t.file}>
              <span className="obs-take-name" title={t.file}>{t.name}</span>
              <span className="obs-take-meta">
                {size(t.size)}, {when(t.modifiedAt)}
              </span>
              <button type="button" className="obs-btn" disabled={busy || shown === t.file} onClick={() => void showTake(t)}>
                {shown === t.file ? 'In the chat' : 'Show in chat'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// the right pane, the Record stage opens it
export default function ObsWorkspace({ brand, project }: WorkspaceProps): ReactNode {
  return (
    <div className="page obs-ws">
      <div className="obs-ws-body">
        <h2 className="obs-ws-title">OBS for {project.name}</h2>
        <ObsPanel key={`${brand.id}:${project.id}`} brand={brand} projectId={project.id} threadId={null} />
      </div>
    </div>
  )
}
