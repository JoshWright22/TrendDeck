import { useEffect, useState, type ReactNode } from 'react'
import type { LoginResult, VaultState } from '@shared/vault'
import './vault.css'

const RESULT_WORDS: Record<LoginResult, string> = {
  logged_in: 'signed in',
  already_logged_in: 'was already signed in',
  needs_code: 'needed a code',
  needs_user: 'needed you',
  no_saved_login: 'had no saved login',
  failed: 'failed'
}

function when(at: number): string {
  const d = new Date(at)
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface Draft {
  siteId: string
  username: string
  password: string
  loginUrl: string
  notes: string
}

// settings section: one saved login per brand and site. the password goes in and never comes back out
export default function SavedLogins({ brandId }: { brandId: string | null }): ReactNode {
  const api = window.trenddeckVault
  const [state, setState] = useState<VaultState | null>(null)
  const [picked, setPicked] = useState<string | null>(brandId)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.getState().then((s) => alive && setState(s))
    }
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api])

  if (!state) return null
  const brand = state.brands.find((b) => b.id === picked) ?? state.brands[0]
  if (!brand) return null
  const attempts = state.attempts.filter((a) => a.brandId === brand.id).slice(-10).reverse()
  const siteName = (id: string): string => brand.sites.find((s) => s.id === id)?.name ?? 'removed site'

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    const why = await api.save(brand.id, draft.siteId, {
      username: draft.username,
      password: draft.password,
      notes: draft.notes,
      loginUrl: draft.loginUrl
    })
    setSaving(false)
    if (why) setError(why)
    else {
      setDraft(null)
      setError('')
    }
  }

  return (
    <section className="saved-logins">
      <h3>Saved logins</h3>
      <p className="form-hint">
        Agents can ask TrendDeck to sign you in. The app fills the form itself, agents never see
        your password or codes. Passwords are locked with your system keychain and can't be shown
        again, only replaced.
      </p>
      {!state.available && <p className="vault-warn">Saving is off: {state.reason}.</p>}

      {state.brands.length > 1 && (
        <div className="aa-brands" role="tablist">
          {state.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === brand.id}
              className={`filter-chip${b.id === brand.id ? ' on' : ''}`}
              onClick={() => {
                setPicked(b.id)
                setDraft(null)
                setError('')
              }}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div className="vault-sites">
        {brand.sites.map((s) => (
          <div key={s.id} className="vault-site">
            <div className="vault-row">
              <span className="vault-name">{s.name}</span>
              <span className="vault-user muted small">{s.login ? s.login.username : 'no login saved'}</span>
              <button
                type="button"
                className="pill"
                disabled={!state.available}
                onClick={() => {
                  setError('')
                  setDraft({
                    siteId: s.id,
                    username: s.login?.username ?? '',
                    password: '',
                    loginUrl: s.login?.loginUrl ?? '',
                    notes: ''
                  })
                }}
              >
                {s.login ? 'Replace' : 'Add'}
              </button>
              {s.login && (
                <button type="button" className="btn ghost" onClick={() => void api.remove(brand.id, s.id)}>
                  Delete
                </button>
              )}
            </div>
            {draft?.siteId === s.id && (
              <form
                className="vault-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void save()
                }}
              >
                <label>
                  Username or email
                  <input
                    value={draft.username}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={draft.password}
                    autoComplete="new-password"
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  />
                </label>
                <label>
                  Sign-in page (optional)
                  <input
                    value={draft.loginUrl}
                    spellCheck={false}
                    placeholder="Leave empty and TrendDeck finds it"
                    onChange={(e) => setDraft({ ...draft, loginUrl: e.target.value })}
                  />
                </label>
                <label>
                  Notes (optional, locked like the password)
                  <textarea
                    rows={2}
                    value={draft.notes}
                    placeholder={s.login?.hasNotes ? 'Saved notes stay hidden, typing here replaces them' : ''}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  />
                </label>
                {error && <p className="vault-warn">{error}</p>}
                <div className="modal-actions">
                  <span className="spacer" />
                  <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={saving}>
                    Save login
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
        {brand.sites.length === 0 && <p className="muted small">No sites yet.</p>}
      </div>

      {attempts.length > 0 && (
        <>
          <h4>Sign-in attempts</h4>
          <ul className="aa-log">
            {attempts.map((a) => (
              <li key={a.id}>
                <span className="muted">{when(a.at)}</span> {siteName(a.siteId)} {RESULT_WORDS[a.result]}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
