import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { usePopover } from './popover'
import './ui.css'

export interface MenuItem {
  label: string
  onSelect: () => void
  // pink, for delete and the like
  danger?: boolean
  disabled?: boolean
  shortcut?: string
  // a hairline above it, to start a group
  divider?: boolean
}

interface Props {
  items: MenuItem[]
  label: string
  // what the trigger shows, three dots by default
  trigger?: ReactNode
  up?: boolean
  // which side the menu lines up with
  align?: 'left' | 'right'
  className?: string
}

// a themed menu button. arrows move, enter picks, escape closes and gives focus back
export function Menu({ items, label, trigger, up, align = 'right', className }: Props): ReactNode {
  const { open, setOpen, root } = usePopover()
  const [active, setActive] = useState(0)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (open) {
      setActive(Math.max(0, items.findIndex((i) => !i.disabled)))
      list.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = (): void => {
    setOpen(false)
    button.current?.focus()
  }

  const pick = (i: number): void => {
    const item = items[i]
    if (!item || item.disabled) return
    close()
    item.onSelect()
  }

  const move = (from: number, step: number): void => {
    let i = from
    for (let n = 0; n < items.length; n++) {
      i = (i + step + items.length) % items.length
      if (!items[i].disabled) break
    }
    setActive(i)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') move(active, 1)
    else if (e.key === 'ArrowUp') move(active, -1)
    else if (e.key === 'Home') move(-1, 1)
    else if (e.key === 'End') move(items.length, -1)
    else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else if (e.key === 'Escape') close()
    else if (e.key === 'Tab') setOpen(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className={`ui-menu${up ? ' up' : ''} ${align}${className ? ` ${className}` : ''}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="ui-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            setOpen(true)
          }
        }}
      >
        {trigger ?? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="3" cy="7" r="1.3" fill="currentColor" />
            <circle cx="7" cy="7" r="1.3" fill="currentColor" />
            <circle cx="11" cy="7" r="1.3" fill="currentColor" />
          </svg>
        )}
      </button>
      {open && (
        <ul
          ref={list}
          className="ui-pop ui-menu-list"
          role="menu"
          id={id}
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => (
            <li
              key={item.label}
              id={`${id}-${i}`}
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              className={`ui-item${i === active ? ' active' : ''}${item.danger ? ' danger' : ''}${item.divider ? ' divided' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="ui-item-label">{item.label}</span>
              {item.shortcut && <kbd className="ui-item-hint">{item.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
