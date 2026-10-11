import { useEffect, useState, type ReactNode } from 'react'
import { PLATFORMS, PLATFORM_NAMES, type Platform } from '@shared/posting'
import { DEFAULT_PACE, type PaceSettings } from '@shared/reuse'
import './reuse.css'

// the Posting pace section in Settings, saves as you type
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
    </>
  )
}
