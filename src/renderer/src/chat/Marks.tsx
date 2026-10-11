import type { ReactNode } from 'react'

// the rising line from the logo's card corners: a small trend line ending in a dot
export function RisingMark({ className }: { className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="-10 -9 20 18" aria-hidden="true">
      <path
        d="M-7 5 L-2 0 L1 3 L6 -3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.5" cy="-4" r="2.6" fill="currentColor" />
    </svg>
  )
}

export function CardCorners({ tone }: { tone?: 'hot' | 'win' }): ReactNode {
  const cls = `cx-mark${tone ? ` ${tone}` : ''}`
  return (
    <>
      <RisingMark className={`${cls} tl`} />
      <RisingMark className={`${cls} br`} />
    </>
  )
}
