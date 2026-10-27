import { useEffect, useState, type ReactNode } from 'react'
import type { VisualCard, VisualsCard } from '@shared/cards'
import {
  assetUrl,
  fileSizeText,
  KIND_NAMES,
  LICENSE_NAMES,
  PROVIDER_NAMES,
  resultSize,
  visualUrl,
  type VisualAsset,
  type VisualResult,
  type VisualSearch
} from '@shared/visuals'
import type { CardActions } from '../cards/useCards'
import VisualActions from './VisualActions'
import './visuals.css'

// a visual in the chat (pasted, dropped, a sketch you sent) and the grid of options found online

function origin(a: VisualAsset): string {
  if (a.source) return `${PROVIDER_NAMES[a.source.provider]}, ${a.source.license.name}${a.source.author ? `, by ${a.source.author}` : ''}`
  if (a.origin === 'sketch') return 'Your sketch'
  if (a.origin === 'link') return 'From a link, license unknown. Check the source before using it in a video.'
  if (a.origin === 'frame') return 'A frame you drew on'
  return 'Pasted'
}

export function VisualItem({ asset, a, label }: { asset: VisualAsset; a: CardActions; label?: string }): ReactNode {
  return (
    <section className="cx-card2 vs-item" aria-label={`${label ?? 'Visual'}: ${asset.name}`}>
      <header className="cx-card2-head">
        <strong>{asset.name}</strong>
        <span className="muted">{label ?? 'Visual'}</span>
      </header>
      <img className="cx-card2-image" src={assetUrl(asset)} alt={asset.name} />
      <p className="cx-card2-note">
        {origin(asset)}
        {asset.width ? `. ${asset.width} by ${asset.height}, ${fileSizeText(asset.bytes)}` : ''}
        {asset.sourceUrl && (
          <>
            {' '}
            <a href={asset.sourceUrl} target="_blank" rel="noreferrer">
              Source
            </a>
          </>
        )}
      </p>
      <VisualActions a={a} kind="image" get={async () => ({ type: 'asset', asset })} />
    </section>
  )
}

export function VisualCardView({ card, a }: { card: VisualCard; a: CardActions }): ReactNode {
  return <VisualItem asset={card.asset} a={a} label={card.asset.origin === 'link' ? 'Dropped in' : 'Pasted'} />
}

// a visual attached to one of your messages, looked up by id
export function VisualAttachment({ id, a }: { id: string; a: CardActions }): ReactNode {
  const [asset, setAsset] = useState<VisualAsset | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void window.trenddeckVisuals
      .asset(a.brand.id, id)
      .then((v) => alive && setAsset(v))
      .catch(() => alive && setAsset(null))
    return () => {
      alive = false
    }
  }, [a.brand.id, id])
  if (asset === undefined) return null
  if (!asset) return <p className="cx-card2-note">That visual is gone.</p>
  return <VisualItem asset={asset} a={a} label={asset.origin === 'sketch' ? 'Sketch' : 'Attached'} />
}

function Tile({ r, brandId, picked, onPick }: { r: VisualResult; brandId: string; picked: boolean; onPick: () => void }): ReactNode {
  return (
    <li>
      <button type="button" className={`vs-tile${picked ? ' picked' : ''}`} aria-pressed={picked} onClick={onPick} title={r.title}>
        <span className="vs-thumb">
          {r.thumb ? <img src={visualUrl(brandId, r.thumb)} alt="" loading="lazy" /> : <span className="vs-thumb-none">{r.kind === 'audio' ? 'Audio' : 'No preview'}</span>}
          {r.duration ? <span className="vs-duration">{resultSize({ width: null, height: null, duration: r.duration, bytes: null })}</span> : null}
        </span>
        <span className="vs-tile-title">{r.title}</span>
        <span className="vs-tile-meta">{PROVIDER_NAMES[r.provider]}</span>
        <span className="vs-tile-meta vs-tile-license">{r.license.name}</span>
        {r.author && <span className="vs-tile-meta">by {r.author}</span>}
        {(r.width && r.height) || r.bytes ? <span className="vs-tile-meta">{resultSize({ ...r, duration: null })}</span> : null}
      </button>
    </li>
  )
}

function Picked({ r, a }: { r: VisualResult; a: CardActions }): ReactNode {
  const needs = [r.license.attribution ? 'Credit needed' : 'No credit needed', r.license.commercial ? 'OK for commercial use' : 'Not for commercial use', r.license.modify ? '' : 'No changes allowed']
    .filter(Boolean)
    .join(', ')
  return (
    <div className="vs-picked">
      {r.kind === 'video' && r.thumb && <img className="cx-card2-image" src={visualUrl(a.brand.id, r.thumb)} alt={r.title} />}
      <p className="cx-card2-body">
        <strong>{r.title}</strong>
        {r.author ? ` by ${r.author}` : ''}, {PROVIDER_NAMES[r.provider]}.{' '}
        <a href={r.license.url || r.pageUrl} target="_blank" rel="noreferrer">
          {r.license.name}
        </a>
        . {needs}.{' '}
        <a href={r.pageUrl} target="_blank" rel="noreferrer">
          Source page
        </a>
      </p>
      <VisualActions key={r.id} a={a} kind={r.kind} get={async () => ({ type: 'result', result: r })} />
    </div>
  )
}

// options to pick from: thumbnails with source, license, author and size. picking one shows what
// you can do with it
export function VisualGrid({ search, a }: { search: VisualSearch; a: CardActions }): ReactNode {
  const [picked, setPicked] = useState<string | null>(null)
  const r = search.results.find((x) => x.id === picked) ?? null
  const off = search.providers.filter((p) => p.state !== 'ok')
  return (
    <div className="vs-grid-wrap">
      {search.results.length ? (
        <ul className="vs-grid" aria-label={`${KIND_NAMES[search.input.kind]} for ${search.input.query}`}>
          {search.results.map((x) => (
            <Tile key={x.id} r={x} brandId={a.brand.id} picked={x.id === picked} onPick={() => setPicked(x.id === picked ? null : x.id)} />
          ))}
        </ul>
      ) : (
        <p className="cx-card2-note">Nothing found. Try fewer or plainer words, another kind, or a looser license.</p>
      )}
      {r && <Picked r={r} a={a} />}
      {!r && search.results.length > 0 && <p className="cx-card2-note">Pick one to send it to your agent, add it to the video files or place it in an editor.</p>}
      {off.length > 0 && (
        <ul className="vs-sources">
          {off.map((p) => (
            <li key={p.provider}>
              {PROVIDER_NAMES[p.provider]}: {p.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function VisualsCardView({ card, a }: { card: VisualsCard; a: CardActions }): ReactNode {
  const s = card.search
  return (
    <section className="cx-card2 vs-card" aria-label={`Options for ${s.input.query}`}>
      <header className="cx-card2-head">
        <strong>{KIND_NAMES[s.input.kind]} for "{s.input.query}"</strong>
        <span className="muted">
          {LICENSE_NAMES[s.input.license]}
          {s.input.orientation ? `, ${s.input.orientation}` : ''}
        </span>
      </header>
      {card.note && <p className="cx-card2-body">{card.note}</p>}
      <VisualGrid search={s} a={a} />
    </section>
  )
}
