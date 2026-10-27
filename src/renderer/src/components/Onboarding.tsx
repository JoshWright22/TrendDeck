import { useState, type ReactNode } from 'react'
import { hostOf, type Brand } from '@shared/types'
import logo from '../../../../resources/logo.svg'
import { WindowButtons } from './TitleBar'
import { RisingMark } from './Icons'

interface Props {
  // the brand a fresh install starts with
  brand: Brand
  onDone: (patch: { name: string; keywords: string[]; siteIds: string[] } | null) => void
}

const STEPS = 3
const isMac = window.trenddeck.platform === 'darwin'

const splitKeywords = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((k) => k.trim().slice(0, 80))
      .filter(Boolean)
  )
]

// first run: name a brand, pick sites, done. skip keeps the defaults
export default function Onboarding({ brand, onDone }: Props): ReactNode {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [picked, setPicked] = useState<string[]>(() => brand.sites.map((s) => s.id))

  const brandName = name.trim() || brand.name
  const canNext = step !== 1 || picked.length > 0
  const finish = (): void => onDone({ name: brandName, keywords: splitKeywords(keywords), siteIds: picked })
  const next = (): void => {
    if (!canNext) return
    if (step < STEPS - 1) setStep(step + 1)
    else finish()
  }
  const toggle = (id: string): void =>
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))

  return (
    <div className="onboard">
      <header className={`titlebar${isMac ? ' mac' : ''}`}>
        <img className="title-logo" src={logo} alt="" draggable={false} />
        <span className="spacer" />
        <button className="btn ghost skip" onClick={() => onDone(null)}>
          Skip setup
        </button>
        {!isMac && <WindowButtons />}
      </header>

      <form
        className="onboard-body"
        onSubmit={(e) => {
          e.preventDefault()
          next()
        }}
      >
        <div className="onboard-step" key={step}>
          {step === 0 && (
            <>
              <h1>Set up your first brand</h1>
              <p className="onboard-lead">Start with one brand. You can add more from the title bar later.</p>
              <label>
                Brand name
                <input
                  autoFocus
                  value={name}
                  maxLength={60}
                  placeholder="My channel"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Niche
                <input
                  value={keywords}
                  placeholder="home espresso, latte art"
                  onChange={(e) => setKeywords(e.target.value)}
                />
              </label>
              <p className="form-hint">A few keywords with commas between. Trends looks for these.</p>
            </>
          )}

          {step === 1 && (
            <>
              <h1>Pick your sites</h1>
              <p className="onboard-lead">
                Each one gets a tab with its own login for {brandName}. Add any other site later.
              </p>
              <div className="pick-grid" role="group" aria-label="Sites">
                {brand.sites.map((s) => {
                  const on = picked.includes(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`pick-card${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggle(s.id)}
                    >
                      <RisingMark className="suit tl" />
                      <span className="pick-letter">{s.name.slice(0, 1).toUpperCase()}</span>
                      <span className="pick-name">{s.name}</span>
                      <span className="pick-host">{hostOf(s.url)}</span>
                    </button>
                  )
                })}
              </div>
              {!canNext && <p className="form-error">Pick at least one.</p>}
            </>
          )}

          {step === 2 && (
            <>
              <h1>You're in</h1>
              <p className="onboard-lead">
                Log in to each site once and it stays logged in for {brandName}. Trends fills in over the next
                minute.
              </p>
              <p className="onboard-lead">Settings has the rest: more keywords, subreddits, the ad blocker.</p>
            </>
          )}
        </div>

        <div className="onboard-foot">
          <div className="dots" aria-label={`Step ${step + 1} of ${STEPS}`}>
            {Array.from({ length: STEPS }, (_, i) => (
              <span key={i} className={i === step ? 'on' : i < step ? 'done' : undefined} />
            ))}
          </div>
          <span className="spacer" />
          {step > 0 && (
            <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button type="submit" className="btn primary" disabled={!canNext}>
            {step === STEPS - 1 ? 'Start' : 'Next'}
          </button>
        </div>
      </form>
    </div>
  )
}
