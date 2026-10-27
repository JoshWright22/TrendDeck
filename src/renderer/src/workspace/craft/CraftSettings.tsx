import { useState, type ReactNode } from 'react'
import type { CraftAppStatus } from '@shared/craft'
import { Dropdown } from '../../chat/ui'
import { LIVE_CHOICES, liveMax, setLiveMax } from '../../chat/cards/embed-owner'
import { InstallProgress, mb } from './CraftWorkspace'
import { craftApi, errorText, putCraft, putCraftList, reloadCraft, useCraftApps } from './store'
import './craft.css'

// Settings, Craft apps: every app of the suite, what's installed and what's newer, and the
// buttons for it. updates download on their own and go in when the app is next closed

function Row({ s }: { s: CraftAppStatus }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const api = craftApi()
  const i = s.install
  const installed = i.kind === 'installed' ? i.version : null
  const newer = installed && s.latest && s.latest !== installed ? s.latest : null
  const act = (fn: () => Promise<unknown>): void => {
    setError('')
    setBusy(true)
    void fn()
      .then((r) => putCraft(r as CraftAppStatus | undefined), (err: unknown) => setError(errorText(err)))
      .finally(() => {
        setBusy(false)
        setConfirm(false)
      })
  }

  let state: ReactNode
  if (i.kind === 'installing') {
    state = (
      <span className="craft-row-progress">
        <InstallProgress received={i.received} total={i.total} />
        <span className="muted">{i.total > 0 ? `${mb(i.received)} of ${mb(i.total)}` : 'Downloading'}</span>
      </span>
    )
  } else if (i.kind === 'failed') state = <span className="craft-error">{i.error}</span>
  else if (s.updateReady) state = <span>Update {s.updateReady} ready, goes in when it closes</span>
  else if (newer) state = <span className="muted">{newer} available</span>
  else if (installed) state = <span className="muted">{s.running ? 'Open' : 'Up to date'}</span>
  else state = <span className="muted">Not installed</span>

  return (
    <tr>
      <td>
        <span className="craft-row-name">{s.app.name}</span>
        <span className="craft-row-blurb" title={s.app.blurb}>
          {s.app.blurb}
        </span>
      </td>
      <td className="num">{installed ?? '-'}</td>
      <td className="num">{s.latest ?? '-'}</td>
      <td>
        {state}
        {error && <span className="craft-error craft-row-error">{error}</span>}
      </td>
      <td className="craft-row-actions">
        {api && i.kind !== 'installing' && !installed && (
          <button className="ws-head-btn" disabled={busy} onClick={() => act(() => api.install(s.app.id))}>
            {i.kind === 'failed' ? 'Retry' : 'Install'}
          </button>
        )}
        {api && installed && (newer || s.updateReady) && (
          <button
            className="ws-head-btn"
            disabled={busy}
            title={s.running ? `Closes ${s.app.name} (it saves first) and updates it` : undefined}
            onClick={() =>
              act(async () => {
                if (s.running) await api.close(s.app.id)
                // a downloaded update goes in on close, otherwise fetch the newer one now
                if (s.updateReady && s.running) return undefined
                return api.install(s.app.id)
              })
            }
          >
            Update now
          </button>
        )}
        {api &&
          installed &&
          (confirm ? (
            <button className="ws-head-btn danger" disabled={busy} onClick={() => act(() => api.uninstall(s.app.id))}>
              Remove {s.app.name}?
            </button>
          ) : (
            <button className="ws-head-btn" disabled={busy} onClick={() => setConfirm(true)} onBlur={() => setConfirm(false)}>
              Uninstall
            </button>
          ))}
      </td>
    </tr>
  )
}

export default function CraftSettings(): ReactNode {
  const apps = useCraftApps()
  const api = craftApi()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [atOnce, setAtOnce] = useState(liveMax())
  if (!api) return <p className="form-hint">This copy of TrendDeck can't run the Craft apps yet.</p>
  return (
    <>
      <p className="form-hint">
        Free editors from the Craft suite on GitHub. FilmCraft and PhotoCraft open inside the chat, the others in their own window, and your agent can work in all of them. Your
        files stay in each project's folder, removing an app doesn't touch them.
      </p>
      <div className="craft-at-once">
        <span>Editors running in the chat at once</span>
        <Dropdown
          label="Editors running in the chat at once"
          value={String(atOnce)}
          options={LIVE_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => {
            setLiveMax(Number(v))
            setAtOnce(Number(v))
          }}
        />
      </div>
      <p className="form-hint">
        Each running editor is a whole copy of the app, about 1 GB of memory for FilmCraft. Ones past the limit show their last
        picture until you scroll to them.
      </p>
      <div className="suggest">
        <button
          type="button"
          className="pill"
          disabled={checking}
          onClick={() => {
            setError('')
            setChecking(true)
            void api
              .checkUpdates()
              .then(putCraftList, (err: unknown) => {
                setError(errorText(err))
                reloadCraft()
              })
              .finally(() => setChecking(false))
          }}
        >
          {checking ? 'Checking...' : 'Check for updates'}
        </button>
        {error && <span className="craft-error">{error}</span>}
      </div>
      {apps === null ? (
        <p className="form-hint">Loading...</p>
      ) : (
        <table className="craft-table">
          <colgroup>
            <col />
            <col className="craft-col-ver" />
            <col className="craft-col-ver" />
            <col className="craft-col-status" />
            <col className="craft-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>App</th>
              <th>Installed</th>
              <th>Latest</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {apps.map((s) => (
              <Row key={s.app.id} s={s} />
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
