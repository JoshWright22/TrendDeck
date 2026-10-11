import type { ReactNode } from 'react'

// a tall phone frame with a play mark
export function ShortsIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2" width="12" height="20" rx="3" />
      <path d="M10.5 9.5v5l4-2.5z" />
    </svg>
  )
}
