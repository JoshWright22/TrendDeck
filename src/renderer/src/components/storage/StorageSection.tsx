import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { StorageRemoteInput, StorageState } from '@shared/storage'
import './storage.css'

// Settings, Storage: where this brand's big video files get copied besides this computer, and
// what happens to the originals. remotes go through rclone, keys go straight into its config

const KINDS: { kind: string; label: string; oauth: boolean }[] = [
  { kind: 'drive', label: 'Google Drive', oauth: true },
  { kind: 'dropbox', label: 'Dropbox', oauth: true },
  { kind: 'onedrive', label: 'OneDrive', oauth: true },
  { kind: 'r2', label: 'Cloudflare R2', oauth: false },
  { kind: 'b2', label: 'Backblaze B2', oauth: false },
  { kind: 's3', label: 'Amazon S3', oauth: false }
]

const EMPTY: StorageRemoteInput = { kind: 'drive', name: '', accessKeyId: '', secretAccessKey: '', region: '', accountId: '' }

const clean = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))

export default function StorageSection({ brand }: { brand: Brand }): ReactNode {
  const api = window.trenddeckStorage
  const [state, setState] = useState<StorageState | null>(null)
  const [dest, setDest] = useState('')
  const [form, setForm] = useState<StorageRemoteInput | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.state(brand.id).then((s) => {
        if (!alive) return
        setState(s)
        setDest(s.settings.defaultDestination)
      })
    }
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api, brand.id])

  if (!state) return <p className="form-hint">Checking for rclone and Git</p>

  const save = async (patch: Parameters<typeof api.setSettings>[1]): Promise<void> => {
    setError('')
    try {
      const s = await api.setSettings(brand.id, patch)
      setState({ ...state, settings: s })
      setDest(s.defaultDestination)
    } catch (err) {
      setError(clean(err))
      setDest(state.settings.defaultDestination)
    }
  }

  const kind = KINDS.find((k) => k.kind === form?.kind) ?? KINDS[0]
  const add = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setError('')
    setNote(kind.oauth ? `Your browser opens to sign in to ${kind.label}. Come back here when it says you're done.` : '')
    try {
      const out = await api.addRemote(form)
      if (out.ok) {
        setNote(out.note)
        setForm(null)
      } else {
        setNote('')
        setError(out.note)
      }
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="form-hint">
        Videos stay on this computer. You can also copy them to the cloud, and your agent asks before every copy. Copies go into
        brand, project and file folders, and never overwrite or delete anything in the cloud.
      </p>
      {!state.rclone && (
        <p className="form-hint">
          Cloud copies use rclone, a free tool. Install it (for example with <code>winget install Rclone.Rclone</code>), then come back.
        </p>
      )}
      {state.rclone && (
        <>
          <ul className="settings-sites" aria-label="Cloud remotes">
            {state.remotes.map((r) => (
              <li key={r.name}>
                <span className="settings-remote-name">{r.name}</span>
                <span className="settings-host">{r.label}</span>
              </li>
            ))}
            {state.remotes.length === 0 && <li className="muted">No cloud remotes yet</li>}
          </ul>
          {state.connecting && <p className="form-hint">Setting up {state.connecting}. Finish signing in in your browser.</p>}
          {form ? (
            <div className="settings-form">
              <label>
                Kind
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Name
                <input value={form.name} maxLength={64} placeholder="videos" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              {!kind.oauth && (
                <>
                  {form.kind === 'r2' && (
                    <label>
                      Cloudflare account id
                      <input value={form.accountId} maxLength={32} onChange={(e) => setForm({ ...form, accountId: e.target.value })} />
                    </label>
                  )}
                  <label>
                    {form.kind === 'b2' ? 'Key id' : 'Access key id'}
                    <input value={form.accessKeyId} autoComplete="off" onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} />
                  </label>
                  <label>
                    {form.kind === 'b2' ? 'Application key' : 'Secret access key'}
                    <input type="password" value={form.secretAccessKey} autoComplete="off" onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} />
                  </label>
                  {form.kind === 's3' && (
                    <label>
                      Region
                      <input value={form.region} placeholder="us-east-1" onChange={(e) => setForm({ ...form, region: e.target.value })} />
                    </label>
                  )}
                  <p className="form-hint">The keys go into rclone's own config on this computer. TrendDeck doesn't keep them and your agent never sees them.</p>
                </>
              )}
              {kind.oauth && <p className="form-hint">Your browser opens to sign in. Drive only lets rclone see the files it makes.</p>}
              <div className="row-actions">
                <button type="button" className="btn" disabled={busy || !form.name.trim()} onClick={() => void add()}>
                  {busy ? 'Setting up' : `Set up ${kind.label}`}
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="suggest">
              <button type="button" className="pill" onClick={() => setForm({ ...EMPTY })}>
                Add a cloud remote
              </button>
            </div>
          )}
          <label>
            Default folder for {brand.name}
            <input
              value={dest}
              list="storage-remotes"
              placeholder={state.remotes[0] ? `${state.remotes[0].name}:TrendDeck` : 'remote:folder'}
              onChange={(e) => setDest(e.target.value)}
              onBlur={() => dest !== state.settings.defaultDestination && void save({ defaultDestination: dest.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <datalist id="storage-remotes">
              {state.remotes.map((r) => (
                <option key={r.name} value={`${r.name}:TrendDeck`} />
              ))}
            </datalist>
          </label>
          <fieldset className="settings-radio">
            <legend>After a copy is checked against the cloud</legend>
            <label className="toggle-row">
              <input type="radio" name={`after-${brand.id}`} checked={state.settings.afterCopy === 'keep'} onChange={() => void save({ afterCopy: 'keep' })} />
              <span>Keep the original on this computer</span>
            </label>
            <label className="toggle-row">
              <input type="radio" name={`after-${brand.id}`} checked={state.settings.afterCopy === 'archive'} onChange={() => void save({ afterCopy: 'archive' })} />
              <span>Move the original to the Recycle Bin to free up space</span>
            </label>
          </fieldset>
        </>
      )}
      <p className="form-hint">
        {state.git
          ? "Project history: scripts, captions and notes in each project folder are kept with Git, so you can go back to an earlier version. Video files aren't. Ask your agent for the history, or open it from the progress card."
          : 'Project history needs Git. Install it (for example with winget install Git.Git), then come back.'}
      </p>
      {note && <p className="form-hint">{note}</p>}
      {error && <p className="form-error">{error}</p>}
    </>
  )
}
