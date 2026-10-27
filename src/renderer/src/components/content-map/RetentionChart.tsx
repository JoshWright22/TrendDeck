import { useId, useRef, useState, type ReactNode } from 'react'
import { clock, type MappedDip, type RetentionPoint } from '@shared/content-map'

// one video's audience retention: the share still watching at each point. one gray line on clear
// axes, the dips as faint bands with their time and loss written on them, a crosshair on hover

const W = 640
const H = 220
const PAD = { left: 44, right: 12, top: 40, bottom: 30 }
const PW = W - PAD.left - PAD.right
const PH = H - PAD.top - PAD.bottom

function niceStep(duration: number): number {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  return steps.find((s) => duration / s <= 6) ?? 3600
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

export default function RetentionChart({ points, duration, dips }: { points: RetentionPoint[]; duration: number; dips: MappedDip[] }): ReactNode {
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<{ ratio: number; watch: number } | null>(null)
  const titleId = useId()
  if (points.length < 2 || !(duration > 0)) return null
  const top = Math.max(1, Math.ceil(Math.max(...points.map((p) => p.watch)) * 4) / 4)
  const x = (ratio: number): number => PAD.left + ratio * PW
  const y = (watch: number): number => PAD.top + PH - (watch / top) * PH
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ratio).toFixed(1)},${y(p.watch).toFixed(1)}`).join('')
  const yTicks = Array.from({ length: Math.round(top / 0.25) + 1 }, (_, i) => i * 0.25)
  // dip labels in two rows so close dips don't write over each other; a third close one goes
  // unlabeled on the chart, the list under it has every dip
  const lastInRow = [-Infinity, -Infinity]
  const rows = dips.map((d) => {
    const at = x(d.from / duration)
    const row = lastInRow.findIndex((r) => at - r >= 110)
    if (row >= 0) lastInRow[row] = at
    return row
  })
  const step = niceStep(duration)
  const xTicks = Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step)

  const move = (clientX: number): void => {
    const box = svg.current?.getBoundingClientRect()
    if (!box) return
    const ratio = Math.min(1, Math.max(0, ((clientX - box.left) / box.width) * W - PAD.left) / PW)
    let near = points[0]
    for (const p of points) if (Math.abs(p.ratio - ratio) < Math.abs(near.ratio - ratio)) near = p
    setHover(near)
  }

  return (
    <figure className="cm-chart">
      <div className="cm-plot">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} onMouseMove={(e) => move(e.clientX)} onMouseLeave={() => setHover(null)}>
          <title id={titleId}>Share of viewers still watching over the video, with {dips.length} dips marked</title>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="cm-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="cm-axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                {pct(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="cm-axis" x={x(t / duration)} y={H - 10} textAnchor={t === 0 ? 'start' : 'middle'}>
              {clock(t)}
            </text>
          ))}
          {dips.map((d, i) => {
            const x1 = x(d.from / duration)
            const x2 = Math.max(x1 + 3, x(d.to / duration))
            return (
              <g key={i}>
                <rect className="cm-dip" x={x1} y={PAD.top} width={x2 - x1} height={PH} />
                {rows[i] >= 0 && (
                  <text className="cm-dip-label" x={x1 > W - 110 ? x2 : x1} y={PAD.top - 8 - rows[i] * 16} textAnchor={x1 > W - 110 ? 'end' : 'start'}>
                    {clock(d.from)}, {pct(d.drop)} left
                  </text>
                )}
              </g>
            )
          })}
          <line className="cm-baseline" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
          <path className="cm-line" d={path} />
          {hover && (
            <g>
              <line className="cm-cross" x1={x(hover.ratio)} x2={x(hover.ratio)} y1={PAD.top} y2={PAD.top + PH} />
              <circle className="cm-dot" cx={x(hover.ratio)} cy={y(hover.watch)} r={4} />
            </g>
          )}
        </svg>
        {hover && (
          <div
            className="cm-tip"
            style={{
              left: `${(x(hover.ratio) / W) * 100}%`,
              top: `${(y(hover.watch) / H) * 100}%`
            }}
            role="status"
          >
            <strong>{clock(hover.ratio * duration)}</strong> {pct(hover.watch)} still watching
          </div>
        )}
      </div>
      <figcaption className="cm-caption">Share of viewers still watching. Faint bands are where more people left than usual.</figcaption>
      <details className="cm-table-toggle">
        <summary>Show as a table</summary>
        <table className="cm-table cm-table-small">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Still watching</th>
            </tr>
          </thead>
          <tbody>
            {points
              .filter((_, i) => i % Math.max(1, Math.round(points.length / 20)) === 0)
              .map((p) => (
                <tr key={p.ratio}>
                  <td>{clock(p.ratio * duration)}</td>
                  <td>{pct(p.watch)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
