import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isHttpUrl, type Brand } from '@shared/types'
import logo from '../../../../resources/logo.svg'
import BrandRail from './BrandRail'
import { PAGES } from './ComingSoon'
import { SearchIcon } from './Icons'
import type { View } from './Sidebar'

export type SearchPick =
  | { kind: 'trends'; query: string }
  | { kind: 'view'; view: View }
  | { kind: 'brand'; id: string }
  | { kind: 'url'; url: string }

interface Result {
  key: string
  label: string
  hint: string
  pick: SearchPick
}

interface Props {
  brands: Brand[]
  brand: Brand | null
  onSelectBrand: (id: string) => void
  onEditBrand: (id: string) => void
  onAddBrand: () => void
  onPick: (pick: SearchPick) => void
}

const isMac = window.trenddeck.platform === 'darwin'
const MAX_RESULTS = 8

// "youtube.com/foo" or a full link, but not plain words
function asUrl(text: string): string | null {
  if (/\s/.test(text)) return null
  const full = /^https?:\/\//i.test(text) ? text : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text) ? `https://${text}` : ''
  return full && isHttpUrl(full) ? full : null
}

function results(query: string, brands: Brand[], brand: Brand | null): Result[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const has = (s: string): boolean => s.toLowerCase().includes(q)
  const out: Result[] = []
  const url = asUrl(query.trim())
  if (url) out.push({ key: 'url', label: `Open ${url}`, hint: 'Tab', pick: { kind: 'url', url } })
  const trends: SearchPick = { kind: 'trends', query: query.trim() }
  out.push({ key: 'trends', label: `Search trends for "${query.trim()}"`, hint: 'Trends', pick: trends })
  for (const p of PAGES) {
    if (has(p)) out.push({ key: `page:${p}`, label: p, hint: 'Page', pick: { kind: 'view', view: { kind: 'page', page: p } } })
  }
  for (const s of brand?.sites ?? []) {
    if (has(s.name) || has(s.url)) {
      out.push({ key: `site:${s.id}`, label: s.name, hint: 'Site', pick: { kind: 'view', view: { kind: 'site', id: s.id } } })
    }
  }
  for (const b of brands) {
    if (b.id !== brand?.id && has(b.name)) {
      out.push({ key: `brand:${b.id}`, label: b.name, hint: 'Brand', pick: { kind: 'brand', id: b.id } })
    }
  }
  for (const i of brand?.ideas ?? []) {
    if (has(i.title)) {
      out.push({ key: `idea:${i.id}`, label: i.title, hint: 'Idea', pick: { kind: 'view', view: { kind: 'page', page: 'Ideas' } } })
    }
  }
  return out.slice(0, MAX_RESULTS)
}

function Search({ brands, brand, onPick }: Pick<Props, 'brands' | 'brand' | 'onPick'>): ReactNode {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = results(query, brands, brand)

  // ctrl+k jumps to search from anywhere in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const choose = (r: Result | undefined): void => {
    if (!r) return
    onPick(r.pick)
    setQuery('')
    setOpen(false)
    input.current?.blur()
  }

  return (
    <div className="title-search">
      <label className="search">
        <SearchIcon />
        <input
          ref={input}
          value={query}
          placeholder="Search trends, sites, brands or paste a link"
          aria-label="Search"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, list.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(list[index])
            } else if (e.key === 'Escape') {
              setQuery('')
              input.current?.blur()
            }
          }}
        />
        <kbd>{isMac ? 'Cmd' : 'Ctrl'} K</kbd>
      </label>
      {open && list.length > 0 && (
        <ul className="search-results" role="listbox">
          {list.map((r, i) => (
            <li
              key={r.key}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'on' : undefined}
              // mousedown so it lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault()
                choose(r)
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="label">{r.label}</span>
              <span className="hint">{r.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function WindowButtons(): ReactNode {
  const [max, setMax] = useState(false)
  useEffect(() => {
    void window.trenddeck.windowControl('state').then(setMax)
    return window.trenddeck.onMaximized(setMax)
  }, [])
  return (
    <div className="win-buttons">
      <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => void window.trenddeck.windowControl('minimize')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        className="win-btn"
        title={max ? 'Restore' : 'Maximize'}
        aria-label={max ? 'Restore' : 'Maximize'}
        onClick={() => void window.trenddeck.windowControl('maximize').then(setMax)}
      >
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" stroke="currentColor" />
            <path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" rx="2" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button className="win-btn close" title="Close" aria-label="Close" onClick={() => void window.trenddeck.windowControl('close')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}

// the whole bar drags the window, double click maximizes. anything clickable opts out in css
export default function TitleBar(props: Props): ReactNode {
  return (
    <header className={`titlebar${isMac ? ' mac' : ''}`}>
      <img className="title-logo" src={logo} alt="" draggable={false} />
      <BrandRail
        brands={props.brands}
        activeId={props.brand?.id ?? null}
        onSelect={props.onSelectBrand}
        onEdit={props.onEditBrand}
        onAdd={props.onAddBrand}
      />
      <span className="spacer" />
      <Search brands={props.brands} brand={props.brand} onPick={props.onPick} />
      <span className="spacer" />
      {!isMac && <WindowButtons />}
    </header>
  )
}
