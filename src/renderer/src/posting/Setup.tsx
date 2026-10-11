import { useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import {
  API_FIELDS,
  PLATFORMS,
  PLATFORM_NAMES,
  type BrandPosting,
  type CheckReport,
  type Platform
} from '@shared/posting'

interface Props {
  brand: Brand
  settings: BrandPosting
}

export default function Setup({ brand, settings }: Props): ReactNode {
  const api = window.trenddeck.posting
  return (
    <div className="posting-setup">
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.autoPost}
          onChange={(e) => void api.setBrand(brand.id, { autoPost: e.target.checked })}
        />
        <span>
          <strong>Press Post for me</strong>
          <span className="muted small">
            Off: TrendDeck fills everything in and stops at the Post button so you can check it.
            On: it presses Post too, scheduled posts go out on their own.
          </span>
        </span>
      </label>
      {PLATFORMS.map((p) => (
        <PlatformRow key={p} platform={p} brand={brand} settings={settings} />
      ))}
    </div>
  )
}

function PlatformRow({ platform, brand, settings }: Props & { platform: Platform }): ReactNode {
  const api = window.trenddeck.posting
  const fields = API_FIELDS[platform]
  const mode = settings.modes[platform]
  const saved = settings.keys[platform]
  const [values, setValues] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<CheckReport | null>(null)

  const check = async (): Promise<void> => {
    setChecking(true)
    setReport(null)
    try {
      setReport(await api.check(brand.id, platform, brand.subreddits[0] ?? ''))
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const saveKeys = async (): Promise<void> => {
    await api.setKeys(brand.id, platform, values)
    setValues({})
    setNote('Saved')
  }

  return (
    <section className="platform-row">
      <header>
        <h3>{PLATFORM_NAMES[platform]}</h3>
        {fields.length > 0 ? (
          <select
            value={mode}
            aria-label={`${PLATFORM_NAMES[platform]} posting mode`}
            onChange={(e) =>
              void api.setBrand(brand.id, { modes: { ...settings.modes, [platform]: e.target.value } })
            }
          >
            <option value="tabs">Logged in tab</option>
            <option value="api">Official API</option>
          </select>
        ) : (
          <span className="muted small">Logged in tab only</span>
        )}
        <span className="spacer" />
        <button className="pill" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking...' : 'Self-check'}
        </button>
      </header>

      {report && (
        <ol className={`check-report${report.ok ? ' ok' : ''}`}>
          {report.steps.map((s, i) => (
            <li key={i} className={s.state}>
              <span className="step-state">{s.state === 'ok' ? 'ok' : s.state === 'broke' ? 'broke' : 'skipped'}</span>
              <span>{s.name}</span>
              {s.detail && <span className="muted">{s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {report && !report.ok && (
        <p className="form-hint">
          Logged out of {PLATFORM_NAMES[platform]}? Log in from its site tab and run this again. If
          you are, the site changed and src/main/posting/adapters/{platform}.ts needs a new selector.
        </p>
      )}

      {mode === 'api' && fields.length > 0 && (
        <form
          className="key-fields"
          onSubmit={(e) => {
            e.preventDefault()
            void saveKeys()
          }}
        >
          {fields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={values[f.key] ?? ''}
                placeholder={saved.includes(f.key) ? 'Saved, type to replace' : ''}
                onChange={(e) => {
                  setNote('')
                  setValues((v) => ({ ...v, [f.key]: e.target.value }))
                }}
              />
            </label>
          ))}
          <div className="key-actions">
            <button type="submit" className="pill teal" disabled={!Object.values(values).some((v) => v.trim())}>
              Save keys
            </button>
            {platform === 'youtube' && (
              <button
                type="button"
                className="pill"
                disabled={!saved.includes('clientId') || !saved.includes('clientSecret')}
                onClick={() => {
                  setNote('Finish the sign in in your browser')
                  void api.connectYouTube(brand.id).then((r) => setNote(r === 'connected' ? 'Connected' : r))
                }}
              >
                {saved.includes('refreshToken') ? 'Reconnect' : 'Connect'}
              </button>
            )}
            {saved.length > 0 && (
              <button
                type="button"
                className="btn ghost small-btn"
                onClick={() => {
                  void api.setKeys(brand.id, platform, null)
                  setNote('Cleared')
                }}
              >
                Clear keys
              </button>
            )}
            {note && <span className="muted small">{note}</span>}
          </div>
          <p className="form-hint">{API_HINTS[platform]}</p>
        </form>
      )}
    </section>
  )
}

const API_HINTS: Record<Platform, string> = {
  youtube:
    'Make an OAuth client of type Desktop app in Google Cloud with the YouTube Data API on, save it here, then Connect. Keys stay on this computer.',
  tiktok:
    'Needs a TikTok developer app with Content Posting. Apps TikTok has not reviewed can only post private.',
  instagram:
    'Needs a business or creator account. Instagram downloads the media from a public link, so add one to each post.',
  x: 'Paste a user token from your X developer app. Images work, videos go through the tab for now.',
  reddit: ''
}
