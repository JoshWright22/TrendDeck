import type { ReactNode } from 'react'
import type { EmulatorStatus } from '@shared/emulator'
import { bytes, RisingMark } from './bits'

interface Props {
  status: EmulatorStatus
  onSetup: () => void
  onCancel: () => void
}

export default function Setup({ status, onSetup, onCancel }: Props): ReactNode {
  const { sdk, virt, setup } = status
  const running = setup?.running === true
  const pct = setup && setup.total > 0 ? Math.min(100, (setup.done / setup.total) * 100) : 0
  const lowDisk = status.freeBytes !== null && status.freeBytes < status.estimateDisk
  const missing = [
    !sdk.emulator && 'the emulator',
    !sdk.adb && 'adb',
    !sdk.image && 'a Play Store system image'
  ].filter(Boolean)

  return (
    <div className="phone-setup scroll">
      <div className="phone-card">
        <RisingMark className="phone-suit tl" />
        <RisingMark className="phone-suit br" />
        <h2>Put a phone in the deck</h2>
        <p>
          Instagram and TikTok keep some things phone only. This runs a real Android phone inside TrendDeck so
          you can use them without picking up yours. Every brand gets its own phone, so each one stays logged in
          to its own accounts.
        </p>

        <div className={`phone-check${virt.ok === false ? ' bad' : virt.ok ? ' good' : ''}`}>
          <strong>
            {virt.ok === false
              ? 'Virtualization is off'
              : virt.ok
                ? 'Virtualization works'
                : 'Virtualization not checked yet'}
          </strong>
          <span>{virt.detail}</span>
        </div>

        {sdk.root && !sdk.owned && missing.length > 0 && (
          <p className="muted small">
            Found an Android SDK at {sdk.root} but it's missing {missing.join(' and ')}. TrendDeck sets up its own
            copy instead and leaves yours alone.
          </p>
        )}

        <ul className="phone-list">
          <li>Android emulator and platform tools</li>
          <li>Android 14 with the Play Store</li>
          <li>
            About {bytes(status.estimateDownload)} to download, {bytes(status.estimateDisk)} on disk, plus up to 6 GB
            per brand phone as you install apps
          </li>
          <li>
            Saved in <code>{status.dataDir}</code>
            {status.freeBytes !== null && <>, {bytes(status.freeBytes)} free there</>}
          </li>
        </ul>
        {lowDisk && <p className="phone-warn">That drive is low on space, setup might not fit.</p>}

        {running && setup ? (
          <div className="phone-progress">
            <div className="phone-progress-top">
              <span>{setup.step}</span>
              {setup.total > 0 && (
                <span className="muted">
                  {bytes(setup.done)} of {bytes(setup.total)}
                </span>
              )}
            </div>
            <div className="phone-bar">
              <div style={{ width: `${pct}%` }} />
            </div>
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="phone-actions">
            <button className="btn primary" onClick={onSetup}>
              {setup?.error ? 'Try again' : 'Download and set up'}
            </button>
            {setup?.error && <span className="phone-warn">{setup.error}</span>}
          </div>
        )}

        <p className="muted small">
          Everything downloads straight from Google and falls under the{' '}
          <a href="https://developer.android.com/studio/terms" target="_blank" rel="noreferrer">
            Android SDK license
          </a>
          . A cancelled setup picks up from the last finished piece.
        </p>
      </div>
    </div>
  )
}
