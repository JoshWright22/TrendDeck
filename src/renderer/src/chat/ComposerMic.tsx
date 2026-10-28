import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_DICTATION_OPTIONS } from '@shared/dictation'
import { dictationSources, useDictationSource } from '../dictation/engine'
import { matchesKey, type DictationControl } from '../dictation/useDictation'
import { openSettings } from '../settings-link'
import { Menu } from './ui'

// the mic in the composer toolbar: click to turn dictation on and off, hold the shortcut to talk,
// a menu for local or API and Settings. while it listens the toolbar shows a level meter,
// the time and Stop; the words land in the text box

function MicIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="4.6" y="1.2" width="4.8" height="7.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.6 6.6a4.4 4.4 0 0 0 8.8 0M7 11v1.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function Chevron(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 6l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export default function ComposerMic({ d, disabled }: { d: DictationControl; disabled?: boolean }): ReactNode {
  const listening = d.state === 'listening' || d.state === 'starting'
  const handsFree = !!d.config?.handsFree
  const holdKey = d.config?.holdKey || DEFAULT_DICTATION_OPTIONS.holdKey

  // hold to talk, anywhere in the window while the composer is up
  useEffect(() => {
    if (disabled) return
    let held = false
    const down = (e: KeyboardEvent): void => {
      if (e.repeat || !matchesKey(e, holdKey)) return
      e.preventDefault()
      if (d.state !== 'idle') return
      held = true
      d.start('hold')
    }
    const up = (e: KeyboardEvent): void => {
      if (!held) return
      const parts = holdKey.split('+').map((p) => p.trim().toLowerCase())
      const key = e.key === ' ' ? 'space' : e.key.toLowerCase()
      if (parts.includes(key) || (key === 'control' && parts.includes('ctrl')) || key === 'alt' || key === 'shift' || key === 'meta') {
        held = false
        d.stop()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [d, holdKey, disabled])

  // Dictate left on stays on: after a restart or an update it starts listening again by itself
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || !d.config || disabled) return
    resumed.current = true
    if (d.config.handsFree && d.state === 'idle') d.start('hands-free')
  }, [d, disabled])

  // downloaded local models and configured providers, for the quick switch
  const [sources, setSources] = useState<Awaited<ReturnType<typeof dictationSources>>>([])
  const loadSources = (): void => void dictationSources().then(setSources).catch(() => setSources([]))
  useEffect(loadSources, [d.config])

  // Dictate is a toggle: on, it keeps listening (and what you say goes into a running reply),
  // off, it stops. holding the shortcut still talks only while held
  const toggle = (): void => {
    if (listening) {
      if (handsFree) d.setOption({ handsFree: false })
      d.stop()
      return
    }
    if (disabled) return
    if (!handsFree) d.setOption({ handsFree: true })
    d.start('hands-free')
  }

  return (
    <div className={`cx-mic${listening ? ' on' : ''}`}>
      <button
        type="button"
        className="ui-menu-btn cx-mic-btn"
        aria-pressed={listening}
        aria-label={listening ? 'Stop dictation' : 'Dictate'}
        title={listening ? 'Stop dictation' : `Dictate to your agent. Click to turn it on and off, or hold ${holdKey} to talk`}
        disabled={(disabled && !listening) || d.state === 'finishing'}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault()
          ;(e.currentTarget.nextElementSibling?.querySelector('button') as HTMLButtonElement | null)?.click()
        }}
      >
        <MicIcon />
        <span>Dictate</span>
      </button>
      <Menu
        label="Dictation options"
        className="cx-mic-menu"
        up
        align="left"
        trigger={<Chevron />}
        items={[
          ...sources.map((src) => ({
            label: `${src.active ? 'Using ' : ''}${src.label}${src.kind === 'api' ? ' (cloud)' : ''}`,
            disabled: src.active,
            onSelect: () => void useDictationSource(src.id).then(loadSources).catch((err: unknown) => d.showError(err, "Couldn't switch the dictation source."))
          })),
          { label: 'Settings...', onSelect: () => openSettings('Dictation'), divider: true }
        ]}
      />
      {listening && (
        <>
          <span className="cx-mic-meter" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.max(0.04, d.level)})` }} />
          </span>
          <time className="cx-mic-time" aria-label="Listening time">
            {clock(d.elapsed)}
          </time>
          <span className="cx-mic-label">Listening</span>
          <button type="button" className="cx-mic-stop" onClick={toggle}>
            Stop
          </button>
        </>
      )}
      {d.state === 'finishing' && <span className="cx-mic-label">Finishing</span>}
    </div>
  )
}
