import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { EmulatorStatus, PhoneKey, PhoneStatus } from '@shared/emulator'
import { BackIcon, HomeIcon } from '../components/Icons'
import Setup from './Setup'
import Screen from './Screen'
import './phone.css'

interface Props {
  brand: Brand
  right?: ReactNode
}

const APPS = [
  { name: 'Instagram', pkg: 'com.instagram.android' },
  { name: 'TikTok', pkg: 'com.zhiliaoapp.musically' }
]

const STATE_TEXT: Record<PhoneStatus['state'], string> = {
  off: 'Off',
  starting: 'Starting',
  booting: 'Booting Android',
  on: 'On',
  stopping: 'Shutting down',
  error: 'Stopped'
}

const RecentsIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
)

export default function PhoneView({ brand, right }: Props): ReactNode {
  const api = window.trenddeck.emulator
  const [status, setStatus] = useState<EmulatorStatus | null>(null)
  const [phone, setPhone] = useState<PhoneStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void api.status().then(setStatus)
  }, [api])

  useEffect(() => {
    refresh()
    void api.phone(brand.id).then(setPhone)
    const offSetup = api.onSetup((p) => {
      setStatus((s) => (s ? { ...s, setup: p } : s))
      if (!p.running) refresh()
    })
    const offPhone = api.onPhone((p) => {
      if (p.brandId === brand.id) setPhone(p)
    })
    return () => {
      offSetup()
      offPhone()
    }
  }, [api, brand.id, refresh])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await fn()
      if (typeof r === 'string' && r) setNote(r)
    } catch (e) {
      setNote((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const key = (k: PhoneKey): void => {
    void api.input(brand.id, { type: 'key', key: k }).catch(() => {})
  }

  const state = phone?.state ?? 'off'
  const on = state === 'on'
  const running = state === 'starting' || state === 'booting' || state === 'on' || state === 'stopping'

  const wipe = (): void => {
    const ok = window.confirm(
      `Delete ${brand.name}'s phone? Every app and login on it goes too. You can make a new one after.`
    )
    if (ok) void act(() => api.wipe(brand.id))
  }

  return (
    <div className="page phone-page">
      <header className="page-head">
        <h2>Phone</h2>
        {status?.ready && (
          <>
            <span className={`phone-state ${state}`}>{STATE_TEXT[state]}</span>
            {running ? (
              <button className="btn ghost" disabled={state === 'stopping' || busy} onClick={() => act(() => api.stop(brand.id))}>
                Turn off
              </button>
            ) : (
              <button className="pill teal" disabled={busy} onClick={() => act(() => api.start(brand.id, brand.name))}>
                {phone?.created ? 'Turn on' : 'Create phone'}
              </button>
            )}
            <span className="phone-sep" />
            <button className="icon-btn" title="Back" aria-label="Back" disabled={!on} onClick={() => key('back')}>
              <BackIcon />
            </button>
            <button className="icon-btn" title="Home" aria-label="Home" disabled={!on} onClick={() => key('home')}>
              <HomeIcon />
            </button>
            <button className="icon-btn" title="Recent apps" aria-label="Recent apps" disabled={!on} onClick={() => key('recents')}>
              <RecentsIcon />
            </button>
            <span className="phone-sep" />
            <button className="btn ghost" disabled={!on} onClick={() => act(() => api.playStore(brand.id))}>
              Play Store
            </button>
            {APPS.map((a) => (
              <button
                key={a.pkg}
                className="btn ghost"
                disabled={!on}
                title={`Open ${a.name} in the Play Store`}
                onClick={() => act(() => api.playStore(brand.id, a.pkg))}
              >
                {a.name}
              </button>
            ))}
            <button className="btn ghost" disabled={!on || busy} onClick={() => act(() => api.installApk(brand.id))}>
              Install APK
            </button>
          </>
        )}
        <span className="spacer" />
        {status?.ready && phone?.created && !running && (
          <button className="btn ghost" onClick={wipe}>
            Delete phone
          </button>
        )}
        {right}
      </header>

      {!status && <div className="phone-body" />}
      {status && !status.ready && (
        <Setup status={status} onSetup={() => void api.setup()} onCancel={() => void api.cancelSetup()} />
      )}
      {status?.ready && (
        <div className="phone-body">
          {note && (
            <div className="phone-note" role="status">
              {note}
              <button className="icon-btn small" aria-label="Dismiss" onClick={() => setNote(null)}>
                ×
              </button>
            </div>
          )}
          {on ? (
            <div className="phone-frame">
              <Screen brandId={brand.id} on={on} />
            </div>
          ) : (
            <div className="phone-off">
              {state === 'error' ? (
                <>
                  <p className="phone-warn">{phone?.message ?? 'The phone stopped.'}</p>
                  {status.virt.ok === false && <p className="muted">{status.virt.detail}</p>}
                </>
              ) : running ? (
                <>
                  <p>{phone?.message ?? `${STATE_TEXT[state]}...`}</p>
                  <p className="muted small">The first start sets up Android and takes a few minutes. After that it's quick.</p>
                </>
              ) : (
                <>
                  <p>{brand.name}'s phone is off.</p>
                  <p className="muted small">
                    {phone?.created
                      ? 'Turn it on to pick up where you left off.'
                      : 'Turning it on makes a new phone just for this brand. Sign in to Google in the Play Store, then install your apps.'}
                  </p>
                </>
              )}
            </div>
          )}
          {on && (
            <p className="phone-hint muted small">
              Click to tap, drag to swipe, scroll to scroll, right click for back. Click the screen and type to send keys.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
