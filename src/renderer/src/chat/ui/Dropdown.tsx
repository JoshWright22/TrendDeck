import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { usePopover } from './popover'
import './ui.css'

export interface DropdownOption<T extends string = string> {
  value: T
  label: string
  // a second line under the label
  hint?: string
  disabled?: boolean
}

interface Props<T extends string> {
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  label: string
  // extra rows under the options, like "Add or edit agents..."
  actions?: { label: string; onSelect: () => void }[]
  // opens upward, for things sitting at the bottom of a view
  up?: boolean
  className?: string
  title?: string
  disabled?: boolean
  // runs when the list opens, e.g. to load options
  onOpen?: () => void
}

// a themed select: button plus listbox. arrows, home/end, enter, escape and type to jump
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
  actions = [],
  up,
  className,
  title,
  disabled,
  onOpen
}: Props<T>): ReactNode {
  const { open, setOpen, root } = usePopover()
  const [active, setActive] = useState(0)
  const listId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const rows = [
    ...options.map((o) => ({ key: `o:${o.value}`, label: o.label, hint: o.hint, disabled: o.disabled, pick: () => onChange(o.value) })),
    ...actions.map((a, i) => ({ key: `a:${i}`, label: a.label, hint: undefined, disabled: false, pick: a.onSelect, action: true }))
  ] as { key: string; label: string; hint?: string; disabled?: boolean; pick: () => void; action?: boolean }[]
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    onOpen?.()
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = (): void => {
    setOpen(false)
    button.current?.focus()
  }

  const choose = (i: number): void => {
    const row = rows[i]
    if (!row || row.disabled) return
    close()
    row.pick()
  }

  const move = (from: number, step: number): void => {
    if (!rows.length) return
    let i = from
    for (let n = 0; n < rows.length; n++) {
      i = (i + step + rows.length) % rows.length
      if (!rows[i].disabled) break
    }
    setActive(i)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') move(active, 1)
    else if (e.key === 'ArrowUp') move(active, -1)
    else if (e.key === 'Home') move(-1, 1)
    else if (e.key === 'End') move(rows.length, -1)
    else if (e.key === 'Enter' || e.key === ' ') choose(active)
    else if (e.key === 'Escape') close()
    else if (e.key === 'Tab') setOpen(false)
    else if (e.key.length === 1) {
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now }
      const hit = rows.findIndex((r) => r.label.toLowerCase().startsWith(typed.current.text))
      if (hit >= 0) setActive(hit)
      return
    } else return
    e.preventDefault()
  }

  return (
    <div className={`ui-dd${up ? ' up' : ''}${className ? ` ${className}` : ''}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="ui-dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={`${label}: ${current?.label ?? 'none'}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKey}
      >
        <span className="ui-dd-value">{current?.label ?? 'None'}</span>
        <svg className="ui-dd-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <ul className="ui-pop ui-dd-list" role="listbox" id={listId} aria-label={label}>
          {rows.map((r, i) => (
            <li
              key={r.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={r.key === `o:${value}`}
              aria-disabled={r.disabled || undefined}
              className={`ui-item${i === active ? ' active' : ''}${r.action ? ' action' : ''}${r.key === `o:${value}` ? ' chosen' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                // inside a <label> the click would reach the button again and reopen the list
                e.preventDefault()
                choose(i)
              }}
            >
              <span className="ui-item-label">{r.label}</span>
              {r.hint && <span className="ui-item-hint">{r.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
