import { useState, type ReactNode } from 'react'
import type { JobInfo } from '@shared/workspace'

// bottom of the sidebar. a placeholder until the pipeline runner sends jobs, pass them in as props then
export default function JobsStrip({ jobs = [] }: { jobs?: JobInfo[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const running = jobs.filter((j) => j.status === 'running')
  const known = running.filter((j) => j.progress !== null)
  const total = known.length ? known.reduce((n, j) => n + (j.progress ?? 0), 0) / known.length : 0
  return (
    <div className={`jobs${open ? ' open' : ''}`}>
      <button className="jobs-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>Jobs</span>
        {running.length ? (
          <>
            <span className="jobs-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(total * 100)}%` }} />
            </span>
            <span className="muted">{running.length}</span>
          </>
        ) : (
          <span className="muted">None running</span>
        )}
      </button>
      {open && (
        <ul className="jobs-list">
          {jobs.length === 0 && <li className="muted">Renders, uploads and other long steps show up here.</li>}
          {jobs.map((j) => (
            <li key={j.id} className={j.status}>
              <span className="jobs-label">{j.label}</span>
              <span className="jobs-bar" aria-hidden="true">
                <span style={{ width: `${Math.round((j.progress ?? 0) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
