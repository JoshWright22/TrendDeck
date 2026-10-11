import type { ReactNode } from 'react'
import { SOURCE_NAMES, type TrendItem } from '@shared/types'
import { ExternalIcon, SaveIcon, Spark } from './Icons'

export function age(at: number | null): string {
  if (at === null) return 'this week'
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// 85 and up counts as hot, the rest is just rising
const isHot = (score: number): boolean => score >= 85

export function ScoreChip({ score, big }: { score: number; big?: boolean }): ReactNode {
  return (
    <span
      className={`score-chip${isHot(score) ? ' hot' : ''}${big ? ' big' : ''}`}
      title="Growth score, 0 to 100 against the rest of this source"
    >
      {score}
    </span>
  )
}

// thin dotted line through the points, the highest one glows
export function Sparkline({ points }: { points: [number, number][] }): ReactNode {
  const w = 200
  const h = 56
  const pad = 6
  const pts = points.length > 1 ? points : [[0, points[0]?.[1] ?? 0] as [number, number], [1, points[0]?.[1] ?? 0] as [number, number]]
  const ts = pts.map((p) => p[0])
  const vs = pts.map((p) => p[1])
  const t0 = Math.min(...ts)
  const t1 = Math.max(...ts)
  const v0 = Math.min(...vs)
  const v1 = Math.max(...vs)
  const x = (t: number): number => pad + ((t - t0) / (t1 - t0 || 1)) * (w - pad * 2)
  const y = (v: number): number => h - pad - ((v - v0) / (v1 - v0 || 1)) * (h - pad * 2)
  const coords = pts.map(([t, v]) => [x(t), y(v)])
  const peak = coords[vs.indexOf(v1)]
  return (
    <svg className="spark-line" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={coords.map((c) => c.join(',')).join(' ')} />
      {coords.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="1.6" className="dot" />
      ))}
      <circle cx={peak[0]} cy={peak[1]} r="7" className="peak-glow" />
      <circle cx={peak[0]} cy={peak[1]} r="3" className="peak" />
    </svg>
  )
}

interface CardProps {
  item: TrendItem
  saved: boolean
  onSave: () => void
  index: number
}

function Corners({ hot }: { hot: boolean }): ReactNode {
  const cls = `suit${hot ? ' hot' : ''}`
  return (
    <>
      <Spark className={`${cls} tl`} />
      <Spark className={`${cls} br`} />
    </>
  )
}

function Actions({ item, saved, onSave }: Omit<CardProps, 'index'>): ReactNode {
  return (
    <div className="card-actions">
      <button className={`pill${saved ? ' done' : ''}`} onClick={onSave} disabled={saved}>
        <SaveIcon />
        {saved ? 'Saved' : 'Save as idea'}
      </button>
      <a className="icon-btn small" href={item.url} target="_blank" rel="noreferrer" title="Open">
        <ExternalIcon />
      </a>
    </div>
  )
}

export function TrendCard({ item, saved, onSave, index }: CardProps): ReactNode {
  return (
    <article
      className={`trend-card src-${item.source}`}
      // stagger the deal, but not forever down a long list
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      <Corners hot={isHot(item.score)} />
      <header>
        <span className="source">{SOURCE_NAMES[item.source]}</span>
        <span className="age">{age(item.publishedAt)}</span>
      </header>
      <a className="trend-title" href={item.url} target="_blank" rel="noreferrer" title={item.title}>
        {item.title}
      </a>
      <p className="trend-detail">{item.detail}</p>
      <div className="card-foot">
        <ScoreChip score={item.score} />
        <Actions item={item} saved={saved} onSave={onSave} />
      </div>
    </article>
  )
}

export function HeroCard({ item, saved, onSave, index }: CardProps): ReactNode {
  return (
    <article className={`hero-card rank-${index + 1}`} style={{ animationDelay: `${index * 90}ms` }}>
      <Corners hot={isHot(item.score)} />
      <div className="hero-top">
        <span className="rank">#{index + 1}</span>
        <ScoreChip score={item.score} big />
      </div>
      <a className="hero-title" href={item.url} target="_blank" rel="noreferrer" title={item.title}>
        {item.title}
      </a>
      <p className="trend-detail">
        {SOURCE_NAMES[item.source]}, {age(item.publishedAt)}
      </p>
      <Sparkline points={item.points} />
      <p className="trend-detail">{item.detail}</p>
      <Actions item={item} saved={saved} onSave={onSave} />
    </article>
  )
}
