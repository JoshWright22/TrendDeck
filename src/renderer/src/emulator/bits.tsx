import type { ReactNode } from 'react'

export function bytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} KB`
}

// the card corner mark, a tiny trend line ending in a dot
export const RisingMark = ({ className }: { className?: string }): ReactNode => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <polyline
      points="2,19 8,13 13,16 19,7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="20" cy="6" r="3" fill="currentColor" />
  </svg>
)
