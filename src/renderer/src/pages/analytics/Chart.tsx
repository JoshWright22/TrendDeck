import { useEffect, useRef, useState, type ReactNode } from 'react'

export type Point = [number, number]

const H = 150
const PAD = { top: 14, right: 16, bottom: 22, left: 46 }

export function short(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function stamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

// thin dotted line through the snapshots, the latest one glows.
// measured in real pixels so text and dots don't stretch
export default function Chart({ points, label }: { points: Point[]; label: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pts = [...points].sort((a, b) => a[0] - b[0])
  if (pts.length === 0) {
    return (
      <div className="an-chart empty" ref={ref}>
        <span className="muted small">No {label.toLowerCase()} yet</span>
      </div>
    )
  }

  const ts = pts.map((p) => p[0])
  const vs = pts.map((p) => p[1])
  const t0 = Math.min(...ts)
  const t1 = Math.max(...ts)
  let v0 = Math.min(...vs)
  let v1 = Math.max(...vs)
  // a flat line sits in the middle instead of on the floor
  if (v0 === v1) {
    v0 = Math.max(0, v0 - Math.max(1, v0 * 0.05))
    v1 = v1 + Math.max(1, v1 * 0.05)
  }
  const iw = Math.max(1, w - PAD.left - PAD.right)
  const ih = H - PAD.top - PAD.bottom
  const x = (t: number): number => PAD.left + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw)
  const y = (v: number): number => PAD.top + ih - ((v - v0) / (v1 - v0)) * ih
  const coords = pts.map(([t, v]) => [x(t), y(v)] as Point)
  const last = coords[coords.length - 1]
  const ticks = [v1, (v0 + v1) / 2, v0]

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - box.left
    let best = 0
    for (let i = 1; i < coords.length; i++) {
      if (Math.abs(coords[i][0] - mx) < Math.abs(coords[best][0] - mx)) best = i
    }
    setHover(best)
  }

  const tip = hover !== null ? { at: pts[hover][0], v: pts[hover][1], c: coords[hover] } : null

  return (
    <div className="an-chart" ref={ref}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          role="img"
          aria-label={`${label}, latest ${short(vs[vs.length - 1])}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((v, i) => (
            <g key={i}>
              <line className="an-grid" x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="an-axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
                {short(Math.round(v))}
              </text>
            </g>
          ))}
          <text className="an-axis" x={PAD.left} y={H - 4}>
            {day(t0)}
          </text>
          {t1 !== t0 && (
            <text className="an-axis" x={w - PAD.right} y={H - 4} textAnchor="end">
              {day(t1)}
            </text>
          )}
          {coords.length > 1 && (
            <polyline className="an-line" points={coords.map((c) => c.join(',')).join(' ')} />
          )}
          {coords.map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={2} className="an-dot" />
          ))}
          <circle cx={last[0]} cy={last[1]} r={9} className="an-glow" />
          <circle cx={last[0]} cy={last[1]} r={4} className="an-latest" />
          {tip && (
            <g>
              <line className="an-cursor" x1={tip.c[0]} x2={tip.c[0]} y1={PAD.top} y2={PAD.top + ih} />
              <circle cx={tip.c[0]} cy={tip.c[1]} r={4} className="an-hover" />
            </g>
          )}
        </svg>
      )}
      {tip && w > 0 && (
        <div
          className="an-tip"
          style={{ left: Math.min(Math.max(tip.c[0], 70), w - 70), top: Math.max(tip.c[1] - 44, 0) }}
        >
          <strong>{tip.v.toLocaleString()}</strong>
          <span>{stamp(tip.at)}</span>
        </div>
      )}
    </div>
  )
}
