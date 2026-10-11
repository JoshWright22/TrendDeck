import { useEffect, useState, type ReactNode } from 'react'
import { PLATFORMS, PLATFORM_NAMES, type Platform } from '@shared/posting'
import { DEFAULT_PACE, type PaceSettings } from '@shared/reuse'
import './reuse.css'

// sits in Settings, saves on its own so the main Save button doesn't need to know about it
export default function PacePanel(): ReactNode {
  const [pace, setPace] = useState<PaceSettings | null>(null)

  useEffect(() => {
    void window.trenddeck.reuse.getPace().then(setPace)
  }, [])

  const save = (next: PaceSettings): void => {
    setPace(next)
    void window.trenddeck.reuse.setPace(next)
  }

  const setRule = (p: Platform, key: 'perDay' | 'gapMinutes', value: string): void => {
    if (!pace) return
    const n = Math.max(0, Math.round(Number(value) || 0))
    save({ ...pace, rules: { ...pace.rules, [p]: { ...pace.rules[p], [key]: n } } })
  }

  return (
    <>
      <h3 className="modal-section">Posting pace</h3>
      <p className="form-hint">
        Scheduled posts wait when a site is over its daily limit or posted too recently, then go out
        a few random minutes later so they don&apos;t land on the dot. 0 means no limit.
      </p>
      {pace && (
        <div className="pace-grid">
          <span />
          <span className="muted small">Per day</span>
          <span className="muted small">Min gap (minutes)</span>
          {PLATFORMS.map((p) => (
            <div key={p} className="pace-row">
              <span>{PLATFORM_NAMES[p]}</span>
              <input
                type="number"
                min={0}
                max={100}
                aria-label={`${PLATFORM_NAMES[p]} posts per day`}
                value={pace.rules[p].perDay}
                onChange={(e) => setRule(p, 'perDay', e.target.value)}
              />
              <input
                type="number"
                min={0}
                max={1440}
                aria-label={`${PLATFORM_NAMES[p]} minutes between posts`}
                value={pace.rules[p].gapMinutes}
                onChange={(e) => setRule(p, 'gapMinutes', e.target.value)}
              />
            </div>
          ))}
          <div className="pace-row">
            <span>Random extra</span>
            <input
              type="number"
              min={0}
              max={120}
              aria-label="Random extra minutes"
              value={pace.jitterMinutes}
              onChange={(e) =>
                save({ ...pace, jitterMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })
              }
            />
            <button type="button" className="btn ghost" onClick={() => save(structuredClone(DEFAULT_PACE))}>
              Reset
            </button>
          </div>
        </div>
      )}

      <h3 className="modal-section">What TrendDeck stores</h3>
      <ul className="form-hint stores-list">
        <li>Brands, sites, ideas and the schedule in trenddeck.json</li>
        <li>Your logins in Partitions, one folder per brand, the same as a normal browser keeps them</li>
        <li>Posts, the post log and posting settings in posting.json</li>
        <li>API keys in posting-keys.json, encrypted with your OS keychain when it&apos;s there</li>
        <li>Posting pace in reuse-pace.json</li>
        <li>Cached trends, drafts, analytics snapshots and ad blocker lists in their own folders</li>
        <li>Videos aren&apos;t copied, posts keep the path to your file</li>
      </ul>
      <p className="form-hint">
        All of it stays in the app&apos;s data folder on this computer. Nothing is sent anywhere except
        the sites you post to.
      </p>
    </>
  )
}
