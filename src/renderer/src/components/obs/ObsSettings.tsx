import { useEffect, useState, type ReactNode } from 'react'
import type { ObsPreferences, ObsRecordingSettings, ObsStatus } from '@shared/obs'
import type { Brand } from '@shared/types'
import { Dropdown } from '../../chat/ui'
import './obs-settings.css'

// Settings, OBS: how TrendDeck reaches OBS on this computer and how this brand records.
// the password is read from OBS's own config in main, it never comes through here

const clean = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))

export default function ObsSettings({ brand }: { brand: Brand }): ReactNode {
  const api = window.trenddeckObs
  const [prefs, setPrefs] = useState<ObsPreferences | null>(null)
  const [status, setStatus] = useState<ObsStatus | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [folder, setFolder] = useState('')
  const [filename, setFilename] = useState('')
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const take = (p: ObsPreferences): void => {
    setPrefs(p)
    setEndpoint(p.endpoint)
    setFolder(p.recording.folder)
    setFilename(p.recording.filename)
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await api.status(brand.id))
    } catch (err) {
      setStatus({ connected: false, endpoint, error: clean(err) })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    let alive = true
    void api.preferences(brand.id).then((p) => alive && take(p)).catch((err) => alive && setError(clean(err)))
    void api.status(brand.id).then((s) => alive && setStatus(s)).catch(() => {})
    return () => {
      alive = false
    }
  }, [api, brand.id])

  if (!prefs) return <p className="form-hint">{error || 'Loading OBS settings'}</p>

  const run = async (fn: () => Promise<ObsPreferences>, done = ''): Promise<boolean> => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      take(await fn())
      if (done) setNote(done)
      return true
    } catch (err) {
      setError(clean(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const connect = async (input: { importLocalPassword?: boolean; clearPassword?: boolean }, done: string): Promise<void> => {
    if (await run(() => api.configure(brand.id, { endpoint: endpoint.trim(), ...input }), done)) void check()
  }

  const save = (patch: Partial<ObsRecordingSettings>): void => {
    void run(() => api.saveSettings(brand.id, patch)).then((ok) => {
      if (!ok) {
        setFolder(prefs.recording.folder)
        setFilename(prefs.recording.filename)
      }
    })
  }

  const r = prefs.recording
  const keepProfile = status?.currentProfile ? `Keep OBS's current profile (${status.currentProfile})` : "Keep OBS's current profile"
  const keepCollection = status?.currentSceneCollection ? `Keep the current scene collection (${status.currentSceneCollection})` : 'Keep the current scene collection'
  const profiles = [{ value: '', label: keepProfile }, ...withSaved(status?.profiles, r.profile).map((p) => ({ value: p, label: p }))]
  const collections = [{ value: '', label: keepCollection }, ...withSaved(status?.sceneCollections, r.sceneCollection).map((c) => ({ value: c, label: c }))]

  return (
    <div className="obs-settings">
      <p className="form-hint">
        For {brand.name}. TrendDeck uses the OBS already on this computer. In OBS, open Tools, WebSocket Server Settings, turn on the server and
        authentication, then import the password here. It stays on this computer and your agent never sees it.
      </p>

      <h4 className="obs-settings-head">Connection</h4>
      <label>
        Address
        <input
          value={endpoint}
          spellCheck={false}
          placeholder="ws://127.0.0.1:4455"
          onChange={(e) => setEndpoint(e.target.value)}
          onBlur={() => endpoint.trim() !== prefs.endpoint && void connect({}, 'Saved the address.')}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <p className="obs-settings-line">
        {status === null || checking
          ? 'Checking OBS'
          : status.connected
            ? `Connected to OBS${status.currentProfile ? `, profile ${status.currentProfile}` : ''}${status.currentSceneCollection ? `, scene collection ${status.currentSceneCollection}` : ''}.`
            : `Not connected. ${status.error ?? ''}`}
      </p>
      <p className="obs-settings-line">{prefs.hasPassword ? 'Password imported from OBS.' : 'No password imported.'}</p>
      <div className="row-actions obs-settings-actions">
        <button type="button" className="obs-settings-btn primary" disabled={busy} onClick={() => void connect({ importLocalPassword: true }, 'Imported the password from OBS.')}>
          Import password from local OBS
        </button>
        <button type="button" className="obs-settings-btn" disabled={busy || checking} onClick={() => void check()}>
          Check connection
        </button>
        {prefs.hasPassword && (
          <button type="button" className="obs-settings-btn" disabled={busy} onClick={() => void connect({ clearPassword: true }, 'Forgot the password.')}>
            Forget password
          </button>
        )}
      </div>

      <h4 className="obs-settings-head">Recording</h4>
      <label>
        Profile
        <Dropdown className="block" label="Profile" value={r.profile} options={profiles} disabled={busy} onOpen={() => void check()} onChange={(v) => save({ profile: v })} />
      </label>
      <p className="form-hint">Your encoder and output settings live in the profile. TrendDeck only switches to one you already have.</p>
      <label>
        Scene collection
        <Dropdown
          className="block"
          label="Scene collection"
          value={r.sceneCollection}
          options={collections}
          disabled={busy}
          onOpen={() => void check()}
          onChange={(v) => save({ sceneCollection: v })}
        />
      </label>
      <label>
        Folder inside the project
        <input
          value={folder}
          spellCheck={false}
          placeholder="footage"
          onChange={(e) => setFolder(e.target.value)}
          onBlur={() => folder.trim() !== r.folder && save({ folder })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <p className="form-hint">
        Recordings go to the project's {r.folder} folder. You can use {'{project}'} and {'{brand}'}. OBS goes back to its own folder when the recording
        stops.
      </p>
      <label>
        File name
        <input
          value={filename}
          spellCheck={false}
          placeholder="Leave empty to keep OBS's own"
          onChange={(e) => setFilename(e.target.value)}
          onBlur={() => filename.trim() !== r.filename && save({ filename })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <p className="form-hint">For example {'{project}'} %CCYY-%MM-%DD %hh-%mm-%ss. The % codes are OBS's own date and time codes.</p>
      <label className="toggle-row">
        <input type="checkbox" checked={r.autoImport} disabled={busy} onChange={(e) => save({ autoImport: e.target.checked })} />
        <span>Bring each recording into the chat when it stops</span>
      </label>

      {note && <p className="form-hint">{note}</p>}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

// OBS's list, plus the saved one when OBS isn't reachable right now
function withSaved(list: string[] | undefined, saved: string): string[] {
  const out = [...(list ?? [])]
  if (saved && !out.includes(saved)) out.unshift(saved)
  return out
}
